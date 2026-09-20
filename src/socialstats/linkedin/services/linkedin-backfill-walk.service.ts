import { LinkedinBackfillWalkState } from '../../../database/entity';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { LinkedinQuotaService } from './linkedin-quota.service';
import { LinkedinService } from './linkedin.service';

type WalkChunkResult = {
	ok: boolean;
	error?: string;
	skipped?: string;
};

type WalkStatus = 'idle' | 'running' | 'stopped' | 'completed';

const WALK_KEY = 'linkedin_backfill_walk';

// LinkedIn's organizationalEntityShareStatistics endpoint returns data only within a rolling
// 12-month window -- confirmed against the live Microsoft Learn docs (2026-09-20). Asking
// past that just returns nothing, so once the walk's cursor is older than this the walk stops
// requesting share statistics (page statistics has no documented window and keeps going).
const SHARE_STATISTICS_LOOKBACK_DAYS = 365;

/**
 * Steps a fixed-size date window backward from `startDate` (default today) toward either the
 * beginning of time or LinkedIn's own data-retention limits, one chunk per tick, until
 * `deadline` -- same shape as MetaBackfillWalkService/YoutubeBackfillWalkService, so an
 * operator who has used one already knows the others. Progress is persisted to
 * LinkedinBackfillWalkState after every tick and reloaded in onModuleInit, so a restart
 * resumes rather than drops the walk.
 *
 * Backfills page statistics and share statistics via LinkedinService's existing
 * getPageStatistics/getShareStatistics, which already accept a startDate/endDate and (after
 * this backfill work) de-duplicate by day so a retried or overlapping chunk doesn't insert a
 * second row for a day already captured. Follower statistics and organization overview are
 * NOT backfilled here -- LinkedIn's API for both is lifetime-aggregate-only, with no
 * timeIntervals equivalent, so there is no historical data to walk through.
 */
@Injectable()
export class LinkedinBackfillWalkService implements OnModuleInit {
	private readonly logger = new Logger(LinkedinBackfillWalkService.name);

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
		private readonly linkedinService: LinkedinService,
		private readonly linkedinQuotaService: LinkedinQuotaService,
		@Inject('LINKEDIN_BACKFILL_WALK_STATE_REPOSITORY')
		private readonly walkStateRepo: typeof LinkedinBackfillWalkState
	) { }

	async onModuleInit() {
		await this.walkStateRepo.sync();

		const row = await this.walkStateRepo.findOne({ where: { walkKey: WALK_KEY } });
		if (!row || row.status !== 'running') {
			return;
		}

		if (new Date(row.deadline).getTime() <= Date.now()) {
			await row.update({ status: 'completed' });
			this.logger.log('LinkedIn backfill walk deadline already passed on startup; marking completed.');
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
			`Resuming LinkedIn backfill walk from persisted state: cursorEnd=${this.cursorEnd} deadline=${this.runOptions.deadline.toISOString()}`
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
			intervalMinutes: this.runOptions?.intervalMinutes ?? null,
			shareStatisticsLookbackFloor: this.formatDate(
				this.addDays(new Date(), -SHARE_STATISTICS_LOOKBACK_DAYS)
			)
		};
	}

	async start(input: { chunkDays?: number; intervalMinutes?: number; deadline?: string; startDate?: string }) {
		if (this.status === 'running') {
			throw new ConflictException('A LinkedIn backfill walk is already running. Stop it first.');
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
		if (chunkDays > 90) {
			throw new BadRequestException('chunkDays cannot exceed 90');
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
			`Starting LinkedIn backfill walk: chunkDays=${chunkDays} intervalMinutes=${intervalMinutes} ` +
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
			this.logger.log('LinkedIn backfill walk stopped by request.');
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
			this.logger.log(`LinkedIn backfill walk reached its deadline at cursorEnd=${this.cursorEnd}. Stopping.`);
			return;
		}

		const shareStatisticsFloor = this.formatDate(this.addDays(new Date(), -SHARE_STATISTICS_LOOKBACK_DAYS));
		if (this.cursorEnd < shareStatisticsFloor) {
			// Page statistics has no documented window, but share statistics does, and once the
			// cursor is entirely past it there is nothing left this walk can usefully do --
			// stopping here (rather than continuing to call page statistics alone forever) keeps
			// the walk's purpose ("backfill what's actually available") honest.
			this.status = 'completed';
			await this.persistState();
			this.logger.log(
				`LinkedIn backfill walk cursor (${this.cursorEnd}) passed the share-statistics 12-month ` +
				`lookback floor (${shareStatisticsFloor}). Stopping -- nothing further to backfill.`
			);
			return;
		}

		const { chunkDays } = this.runOptions;
		const cursorEnd = this.cursorEnd;
		const cursorStart = this.shiftDate(cursorEnd, -(chunkDays - 1));

		const results: Record<string, WalkChunkResult> = {};
		let shouldRetrySameWindow = false;

		const attempts: Array<[string, () => Promise<unknown>]> = [
			['pageStatistics', () => this.linkedinService.getPageStatistics(cursorStart, cursorEnd)]
		];

		if (cursorStart >= shareStatisticsFloor) {
			attempts.push(['shareStatistics', () => this.linkedinService.getShareStatistics(cursorStart, cursorEnd)]);
		} else {
			// Chunk straddles the floor -- page statistics still covers the whole window, but
			// share statistics would silently return nothing for the part beyond it, so skip it
			// for this chunk rather than recording a misleading "ok" with zero rows.
			results.shareStatistics = { ok: false, skipped: 'chunk extends past the 12-month share-statistics window' };
		}

		for (const [label, run] of attempts) {
			try {
				await run();
				results[label] = { ok: true };
			} catch (error: any) {
				results[label] = { ok: false, error: error?.message ?? String(error) };
				if (this.linkedinQuotaService.isQuotaExceededError(error) || error?.response?.status === 429) {
					shouldRetrySameWindow = true;
				}
				this.logger.warn(`LinkedIn backfill walk chunk ${cursorStart}..${cursorEnd} [${label}] failed: ${results[label].error}`);
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

	private addDays(date: Date, days: number) {
		const copy = new Date(date);
		copy.setUTCDate(copy.getUTCDate() + days);
		return copy;
	}

	private shiftDate(dateStr: string, days: number) {
		const date = new Date(`${dateStr}T00:00:00.000Z`);
		date.setUTCDate(date.getUTCDate() + days);
		return this.formatDate(date);
	}
}
