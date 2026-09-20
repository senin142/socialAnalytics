import { MetaBackfillWalkState } from '../../../database/entity';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MetaIngestService } from './meta-ingest.service';

type WalkChunkResult = {
	ok: boolean;
	error?: string;
};

type WalkStatus = 'idle' | 'running' | 'stopped' | 'completed';

const WALK_KEY = 'meta_backfill_walk';

/**
 * Steps a fixed-size date window backward from `startDate` (default today) toward the
 * beginning of time, one chunk per tick, until `deadline`. Progress is persisted to
 * MetaBackfillWalkState after every tick, and reloaded in onModuleInit, so a process
 * restart or redeploy resumes the walk instead of silently dropping it -- the in-memory
 * setTimeout chain is just the current process's scheduler; the source of truth is the
 * DB row.
 *
 * A chunk that hits a conflict (another run already in flight) or a rate limit is retried
 * as-is next tick instead of being skipped, since both `backfillProfileSnapshot` and
 * `ingestGeoSnapshot`/`ingestContentSnapshot` already enforce the shared-run lock and Meta's
 * cooldown internally (see MetaIngestService.claimSharedRun, MetaRateLimitService) -- retrying
 * is what lets the walk cooperate with the scheduler's own cron jobs instead of racing them.
 * Any other failure is logged and the cursor still advances, so one bad chunk can't stall the
 * rest of the backlog.
 */
@Injectable()
export class MetaBackfillWalkService implements OnModuleInit {
	private readonly logger = new Logger(MetaBackfillWalkService.name);

	private timer: NodeJS.Timeout | null = null;
	private status: WalkStatus = 'idle';
	private cursorEnd: string | null = null;
	private lastTickAt: Date | null = null;
	private lastResult: Record<string, WalkChunkResult> | null = null;
	private runOptions: {
		pageId?: string;
		instagramId?: string;
		chunkDays: number;
		intervalMinutes: number;
		deadline: Date;
	} | null = null;

	constructor(
		private readonly metaIngestService: MetaIngestService,
		@Inject('META_BACKFILL_WALK_STATE_REPOSITORY')
		private readonly walkStateRepo: typeof MetaBackfillWalkState
	) { }

	async onModuleInit() {
		await this.walkStateRepo.sync();

		const row = await this.walkStateRepo.findOne({ where: { walkKey: WALK_KEY } });
		if (!row || row.status !== 'running') {
			return;
		}

		if (new Date(row.deadline).getTime() <= Date.now()) {
			await row.update({ status: 'completed' });
			this.logger.log('Meta backfill walk deadline already passed on startup; marking completed.');
			return;
		}

		this.runOptions = {
			pageId: row.pageId ?? undefined,
			instagramId: row.instagramId ?? undefined,
			chunkDays: row.chunkDays,
			intervalMinutes: row.intervalMinutes,
			deadline: new Date(row.deadline)
		};
		this.cursorEnd = row.cursorEnd;
		this.lastTickAt = row.lastTickAt;
		this.lastResult = row.lastResult ? JSON.parse(row.lastResult) : null;
		this.status = 'running';

		this.logger.log(
			`Resuming Meta backfill walk from persisted state: cursorEnd=${this.cursorEnd} deadline=${this.runOptions.deadline.toISOString()}`
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

	async start(input: {
		pageId?: string;
		instagramId?: string;
		chunkDays?: number;
		intervalMinutes?: number;
		deadline?: string;
		startDate?: string;
	}) {
		if (this.status === 'running') {
			throw new ConflictException('A Meta backfill walk is already running. Stop it first.');
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
			throw new BadRequestException('chunkDays cannot exceed 90 (the underlying backfill endpoints cap at 90 days per call)');
		}
		const intervalMinutes = input.intervalMinutes && input.intervalMinutes > 0
			? Math.floor(input.intervalMinutes)
			: 30;

		this.runOptions = {
			pageId: input.pageId,
			instagramId: input.instagramId,
			chunkDays,
			intervalMinutes,
			deadline
		};
		this.cursorEnd = input.startDate ?? this.formatDate(new Date());
		this.status = 'running';
		this.lastResult = null;
		this.lastTickAt = null;

		await this.persistState();

		this.logger.log(
			`Starting Meta backfill walk: chunkDays=${chunkDays} intervalMinutes=${intervalMinutes} ` +
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
			this.logger.log('Meta backfill walk stopped by request.');
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
			this.logger.log(`Meta backfill walk reached its deadline at cursorEnd=${this.cursorEnd}. Stopping.`);
			return;
		}

		const { pageId, instagramId, chunkDays } = this.runOptions;
		const cursorEnd = this.cursorEnd;
		const cursorStart = this.shiftDate(cursorEnd, -(chunkDays - 1));

		const results: Record<string, WalkChunkResult> = {};
		let shouldRetrySameWindow = false;

		const attempts: Array<[string, () => Promise<unknown>]> = [
			[
				'profileSnapshot',
				() => this.metaIngestService.backfillProfileSnapshot({ pageId, startDate: cursorStart, endDate: cursorEnd })
			],
			[
				'contentSnapshot',
				() => this.metaIngestService.ingestContentSnapshot({
					pageId,
					instagramId,
					from: cursorStart,
					to: cursorEnd,
					includePosts: true,
					includeMedia: true
				})
			],
			[
				'geoSnapshot',
				() => this.metaIngestService.ingestGeoSnapshot({ pageId, instagramId, startDate: cursorStart, endDate: cursorEnd })
			]
		];

		for (const [label, run] of attempts) {
			try {
				await run();
				results[label] = { ok: true };
			} catch (error: any) {
				const httpStatus = error?.status ?? error?.response?.statusCode;
				const isConflictOrRateLimit = httpStatus === 409 || httpStatus === 429;
				results[label] = { ok: false, error: error?.message ?? String(error) };
				if (isConflictOrRateLimit) {
					shouldRetrySameWindow = true;
				}
				this.logger.warn(`Meta backfill walk chunk ${cursorStart}..${cursorEnd} [${label}] failed: ${results[label].error}`);
			}
		}

		this.lastResult = results;
		this.lastTickAt = new Date();

		if (shouldRetrySameWindow) {
			this.logger.warn(`Chunk ${cursorStart}..${cursorEnd} hit a conflict/rate limit; retrying the same window next tick.`);
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
			pageId: this.runOptions?.pageId ?? null,
			instagramId: this.runOptions?.instagramId ?? null,
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
