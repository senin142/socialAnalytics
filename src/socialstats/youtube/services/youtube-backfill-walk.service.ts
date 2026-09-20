import { YoutubeBackfillWalkState } from '../../../database/entity';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IngestionControlService } from '../../shared/services/ingestion-control.service';
import { IngestionRunConflictError, IngestionRunsService } from '../../shared/services/ingestion-runs.service';
import { YoutubeQuotaService } from './youtube-quota.service';
import { YoutubeService } from './youtube.service';

type WalkChunkResult = {
	ok: boolean;
	error?: string;
	// 'lock' = another run (usually the nightly cron) already holds this job's lock;
	// 'quota' = the daily quota budget is exhausted. Both mean "not a failure, retry the
	// same window next tick" -- distinct from `error`, which is a real, unexpected failure.
	skipped?: 'lock' | 'quota';
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
 *
 * IMPORTANT: unlike Meta, where the shared-run lock lives inside MetaIngestService's methods
 * (so any caller automatically cooperates with it), YouTube's lock lives one layer up in
 * YoutubeIngestService -- YoutubeService's own methods have no locking at all. Calling them
 * directly, as this walk needs to, would otherwise let a tick race the nightly
 * geo_device/video_retention cron jobs and double-write. This walk claims the same
 * (platform, jobType, entityType) lock those crons use -- 'youtube'/'geo_device'/'channel' and
 * 'youtube'/'video_retention'/'channel' -- via IngestionRunsService before each call, so
 * whichever gets there first wins the tick and the other retries next time. video_geo has no
 * existing cron, so there's nothing to race, but it's locked under a 'video_geo' jobType too
 * for consistency and so a future cron for it would cooperate automatically. This also means
 * the walk's activity shows up in GET .../ingestion/status like any other job.
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
		private readonly ingestionRunsService: IngestionRunsService,
		private readonly ingestionControlService: IngestionControlService,
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

		const attempts: Array<[string, string, () => Promise<unknown>]> = [
			[
				'geoDeviceStats',
				'geo_device',
				() => this.youtubeService.ingestDailyGeoDeviceStats(undefined, cursorStart, cursorEnd)
			],
			[
				'videoGeoStats',
				'video_geo',
				() => this.youtubeService.ingestDailyVideoGeoStats(TOP_N_VIDEOS, undefined, cursorStart, cursorEnd)
			],
			[
				'videoRetention',
				'video_retention',
				() => this.youtubeService.ingestDailyVideoRetentionStats(TOP_N_VIDEOS, cursorStart, cursorEnd, true)
			]
		];

		for (const [label, jobType, run] of attempts) {
			const outcome = await this.runLockedJob(jobType, cursorStart, cursorEnd, run);
			results[label] = outcome;
			if (!outcome.ok && outcome.skipped) {
				shouldRetrySameWindow = true;
			}
			if (!outcome.ok && outcome.error) {
				this.logger.warn(`YouTube backfill walk chunk ${cursorStart}..${cursorEnd} [${label}] failed: ${outcome.error}`);
			}
		}

		this.lastResult = results;
		this.lastTickAt = new Date();

		if (shouldRetrySameWindow) {
			this.logger.warn(`Chunk ${cursorStart}..${cursorEnd} hit a lock conflict or the daily quota budget; retrying the same window next tick.`);
		} else {
			this.cursorEnd = this.shiftDate(cursorStart, -1);
			this.logger.log(`Chunk ${cursorStart}..${cursorEnd} done. Cursor advanced to ${this.cursorEnd}.`);
		}

		await this.persistState();
		this.scheduleNextTick(this.runOptions.intervalMinutes * 60_000);
	}

	/**
	 * Claims the same (platform, jobType, entityType) lock YoutubeIngestService's cron jobs
	 * use before running `run`, so a backfill tick and the nightly cron can never both write
	 * for the same job at once. A lock conflict or a paused job is reported as `skipped:
	 * 'lock'` and treated as a same-window retry next tick, not a failure -- the cron (or
	 * another walk instance) is doing the work instead, which is the point of the lock.
	 */
	private async runLockedJob(
		jobType: string,
		cursorStart: string,
		cursorEnd: string,
		run: () => Promise<unknown>
	): Promise<WalkChunkResult> {
		const pauseState = await this.ingestionControlService.isPaused('youtube', jobType);
		if (pauseState.paused) {
			return { ok: false, skipped: 'lock' };
		}

		let ingestionRun;
		try {
			ingestionRun = await this.ingestionRunsService.createRun({
				platform: 'youtube',
				entityType: 'channel',
				entityId: 'backfill_walk',
				jobType,
				runType: 'backfill',
				triggerSource: 'backfill_walk',
				scopeStartDate: cursorStart,
				scopeEndDate: cursorEnd
			});
		} catch (error) {
			if (error instanceof IngestionRunConflictError) {
				return { ok: false, skipped: 'lock' };
			}
			throw error;
		}

		try {
			await run();
			await this.ingestionRunsService.completeRun(ingestionRun.id, {
				entityId: 'backfill_walk',
				scopeStartDate: cursorStart,
				scopeEndDate: cursorEnd
			});
			return { ok: true };
		} catch (error: any) {
			await this.ingestionRunsService.failRun(ingestionRun.id, error, {
				entityId: 'backfill_walk',
				scopeStartDate: cursorStart,
				scopeEndDate: cursorEnd
			});
			if (this.youtubeQuotaService.isQuotaExceededError(error)) {
				return { ok: false, skipped: 'quota' };
			}
			return { ok: false, error: error?.message ?? String(error) };
		}
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
