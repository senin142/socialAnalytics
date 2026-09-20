import { YoutubeBackfillWalkState } from '../../../database/entity';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { YoutubeQuotaService } from './youtube-quota.service';
import { YoutubeService } from './youtube.service';

type WalkChunkResult = {
	ok: boolean;
	error?: string;
};

type WalkStatus = 'idle' | 'running' | 'stopped' | 'completed';

const WALK_KEY = 'youtube_backfill_walk';
const TOP_N_VIDEOS = 10;

/**
 * Steps a fixed-size date window backward from `startDate` (default today) toward the
 * beginning of time, one chunk per tick, until `deadline` -- same shape as
 * MetaBackfillWalkService, so an operator who has used one already knows the other.
 * Progress is persisted to YoutubeBackfillWalkState after every tick and reloaded in
 * onModuleInit, so a restart resumes rather than drops the walk.
 *
 * Backfills geo/device breakdown, per-video geography, and (with force=true) video
 * retention. Retention normally skips a video whose curve was captured recently
 * (isRefreshDue, tuned for the live/cron path); force bypasses that check specifically
 * because a backfill walk is asking for a historical window regardless of when the video
 * was last touched -- see the `force` parameter added to
 * YoutubeService.ingestDailyVideoRetentionStats for the full reasoning.
 *
 * YouTube Analytics' reports.query has no documented hard lookback limit (unlike Meta's
 * lifetime-only geo insights or LinkedIn's 12-month share-statistics window), so this walk
 * has no built-in floor -- it runs until `deadline` or an admin stops it. A chunk that hits
 * YoutubeQuotaService's daily budget limit is retried as-is next tick rather than skipped,
 * since the budget resets at midnight Pacific and the walk's tick interval is normally much
 * longer than the time until reset.
 */
@Injectable()
export class YoutubeBackfillWalkService implements OnModuleInit {
	private readonly logger = new Logger(YoutubeBackfillWalkService.name);

	private timer: NodeJS.Timeout | null = null;
	private status: WalkStatus = 'idle';
	private cursorEnd: string | null = null;
	private lastTickAt: Date | null = null;
	private lastResult: Record<string, WalkChunkResult> | null = null;
	private runOptions: {
		chunkDays: number;
		intervalMinutes: number;
		deadline: Date;
	} | null = null;

	constructor(
		private readonly youtubeService: YoutubeService,
		private readonly youtubeQuotaService: YoutubeQuotaService,
		@Inject('YOUTUBE_BACKFILL_WALK_STATE_REPOSITORY')
		private readonly walkStateRepo: typeof YoutubeBackfillWalkState
	) { }

	async onModuleInit() {
		await this.walkStateRepo.sync();

		const row = await this.walkStateRepo.findOne({ where: { walkKey: WALK_KEY } });
		if (!row || row.status !== 'running') {
			return;
		}

		if (new Date(row.deadline).getTime() <= Date.now()) {
			await row.update({ status: 'completed' });
			this.logger.log('YouTube backfill walk deadline already passed on startup; marking completed.');
			return;
		}

		this.runOptions = {
			chunkDays: row.chunkDays,
			intervalMinutes: row.intervalMinutes,
			deadline: new Date(row.deadline)
		};
		this.cursorEnd = row.cursorEnd;
		this.lastTickAt = row.lastTickAt;
		this.lastResult = row.lastResult ? JSON.parse(row.lastResult) : null;
		this.status = 'running';

		this.logger.log(
			`Resuming YouTube backfill walk from persisted state: cursorEnd=${this.cursorEnd} deadline=${this.runOptions.deadline.toISOString()}`
		);
		this.scheduleNextTick(0);
	}

	getStatus() {
		return {
			status: this.status,
			cursorEnd: this.cursorEnd,
			lastTickAt: this.lastTickAt,
			lastResult: this.lastResult,
			deadline: this.runOptions?.deadline ?? null,
			chunkDays: this.runOptions?.chunkDays ?? null,
			intervalMinutes: this.runOptions?.intervalMinutes ?? null
		};
	}

	async start(input: { chunkDays?: number; intervalMinutes?: number; deadline?: string; startDate?: string }) {
		if (this.status === 'running') {
			throw new ConflictException('A YouTube backfill walk is already running. Stop it first.');
		}

		if (!input.deadline) {
			throw new BadRequestException('deadline is required (ISO timestamp to stop the walk by)');
		}
		const deadline = new Date(input.deadline);
		if (Number.isNaN(deadline.getTime())) {
			throw new BadRequestException('deadline must be a valid ISO timestamp');
		}
		if (deadline.getTime() <= Date.now()) {
			throw new BadRequestException('deadline must be in the future');
		}

		const chunkDays = input.chunkDays && input.chunkDays > 0 ? Math.floor(input.chunkDays) : 14;
		if (chunkDays > 60) {
			// The geo/device endpoint alone caps a single call at 366 days, but each chunk
			// also runs per-video retention and per-video geo for every day in the window --
			// keeping chunks modest keeps a single tick's quota spend predictable.
			throw new BadRequestException('chunkDays cannot exceed 60 (keeps a single tick\'s quota spend bounded)');
		}
		const intervalMinutes = input.intervalMinutes && input.intervalMinutes > 0
			? Math.floor(input.intervalMinutes)
			: 30;

		this.runOptions = { chunkDays, intervalMinutes, deadline };
		this.cursorEnd = input.startDate ?? this.formatDate(new Date());
		this.status = 'running';
		this.lastResult = null;
		this.lastTickAt = null;

		await this.persistState();

		this.logger.log(
			`Starting YouTube backfill walk: chunkDays=${chunkDays} intervalMinutes=${intervalMinutes} ` +
			`deadline=${deadline.toISOString()} startingCursorEnd=${this.cursorEnd}`
		);

		this.scheduleNextTick(0);
		return this.getStatus();
	}

	async stop() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.status === 'running') {
			this.status = 'stopped';
			await this.persistState();
			this.logger.log('YouTube backfill walk stopped by request.');
		}
		return this.getStatus();
	}

	private scheduleNextTick(delayMs: number) {
		this.timer = setTimeout(() => {
			this.runTick().catch((error: any) => {
				this.logger.error(`Backfill walk tick crashed unexpectedly: ${error?.message ?? error}`);
			});
		}, delayMs);
	}

	private async runTick() {
		if (this.status !== 'running' || !this.runOptions || !this.cursorEnd) {
			return;
		}

		if (Date.now() >= this.runOptions.deadline.getTime()) {
			this.status = 'completed';
			await this.persistState();
			this.logger.log(`YouTube backfill walk reached its deadline at cursorEnd=${this.cursorEnd}. Stopping.`);
			return;
		}

		const { chunkDays } = this.runOptions;
		const cursorEnd = this.cursorEnd;
		const cursorStart = this.shiftDate(cursorEnd, -(chunkDays - 1));

		const results: Record<string, WalkChunkResult> = {};
		let shouldRetrySameWindow = false;

		const attempts: Array<[string, () => Promise<unknown>]> = [
			[
				'geoDeviceStats',
				() => this.youtubeService.ingestDailyGeoDeviceStats(undefined, cursorStart, cursorEnd)
			],
			[
				'videoGeoStats',
				() => this.youtubeService.ingestDailyVideoGeoStats(TOP_N_VIDEOS, undefined, cursorStart, cursorEnd)
			],
			[
				'videoRetention',
				() => this.youtubeService.ingestDailyVideoRetentionStats(TOP_N_VIDEOS, cursorStart, cursorEnd, true)
			]
		];

		for (const [label, run] of attempts) {
			try {
				await run();
				results[label] = { ok: true };
			} catch (error: any) {
				results[label] = { ok: false, error: error?.message ?? String(error) };
				if (this.youtubeQuotaService.isQuotaExceededError(error)) {
					shouldRetrySameWindow = true;
				}
				this.logger.warn(`YouTube backfill walk chunk ${cursorStart}..${cursorEnd} [${label}] failed: ${results[label].error}`);
			}
		}

		this.lastResult = results;
		this.lastTickAt = new Date();

		if (shouldRetrySameWindow) {
			this.logger.warn(`Chunk ${cursorStart}..${cursorEnd} hit the daily quota budget; retrying the same window next tick.`);
		} else {
			this.cursorEnd = this.shiftDate(cursorStart, -1);
			this.logger.log(`Chunk ${cursorStart}..${cursorEnd} done. Cursor advanced to ${this.cursorEnd}.`);
		}

		await this.persistState();
		this.scheduleNextTick(this.runOptions.intervalMinutes * 60_000);
	}

	private async persistState() {
		const payload = {
			walkKey: WALK_KEY,
			status: this.status,
			chunkDays: this.runOptions?.chunkDays ?? 14,
			intervalMinutes: this.runOptions?.intervalMinutes ?? 30,
			deadline: this.runOptions?.deadline ?? new Date(),
			cursorEnd: this.cursorEnd,
			lastTickAt: this.lastTickAt,
			lastResult: this.lastResult ? JSON.stringify(this.lastResult) : null
		};

		const existing = await this.walkStateRepo.findOne({ where: { walkKey: WALK_KEY } });
		if (existing) {
			await existing.update(payload);
		} else {
			await this.walkStateRepo.create(payload);
		}
	}

	private formatDate(date: Date) {
		return date.toISOString().slice(0, 10);
	}

	private shiftDate(dateStr: string, days: number) {
		const date = new Date(`${dateStr}T00:00:00.000Z`);
		date.setUTCDate(date.getUTCDate() + days);
		return this.formatDate(date);
	}
}
