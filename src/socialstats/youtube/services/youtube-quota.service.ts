import { YoutubeQuotaUsage } from '../../../database/entity';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

export type YoutubeQuotaPool = 'youtube_data_v3' | 'youtube_analytics';

export class YoutubeQuotaExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'YoutubeQuotaExceededError';
	}
}

/**
 * YouTube Data API v3 has a strict, well-documented per-day unit budget (default 10,000
 * units, resets at midnight Pacific). YouTube Analytics API (youtubeanalytics.googleapis.com)
 * is a separate quota pool with its own (much less granular) budget. This service tracks
 * both pools in the DB so usage survives restarts/multiple instances, refuses calls once a
 * pool is close to its daily budget, and gives the ingestion status endpoint something to
 * report instead of silently hitting quotaExceeded.
 */
@Injectable()
export class YoutubeQuotaService implements OnModuleInit {
	private readonly logger = new Logger(YoutubeQuotaService.name);
	private readonly dailyDataV3UnitBudget = Number(
		process.env.YOUTUBE_DATA_V3_DAILY_UNIT_BUDGET ?? 10000
	);
	private readonly dailyAnalyticsCallBudget = Number(
		process.env.YOUTUBE_ANALYTICS_DAILY_CALL_BUDGET ?? 5000
	);
	private readonly reserveBufferPercent = Number(
		process.env.YOUTUBE_QUOTA_RESERVE_PERCENT ?? 10
	);

	// Matched by prefix (not exact label) since call sites append disambiguating suffixes
	// to the base endpoint name (e.g. "youtube.videos.list.live-streaming-details") — all
	// of these are .list calls, which YouTube Data API v3 documents at 1 unit regardless
	// of which fields/filters are requested.
	private static readonly DATA_V3_UNIT_COSTS: Array<{ prefix: string; cost: number }> = [
		{ prefix: 'youtube.channels.', cost: 1 },
		{ prefix: 'youtube.videos.', cost: 1 },
		{ prefix: 'youtube.liveBroadcasts.', cost: 1 }
	];

	// Per-pool running total for "today", kept in memory so the budget check on every
	// single YouTube API call doesn't have to hit the DB. Every call reads/increments this
	// in-process number; it is re-synced from the DB (which every instance increments) at
	// most once per `usageResyncIntervalMs`, so a second instance's spend becomes visible
	// here within that interval instead of never. Reloading only once a day, as this did,
	// meant each instance believed it had the whole daily budget to itself.
	private readonly inMemoryUsage = new Map<
		YoutubeQuotaPool,
		{ usageDate: string; unitsUsed: number; syncedAt: number }
	>();
	private readonly usageResyncIntervalMs = Number(
		process.env.YOUTUBE_QUOTA_RESYNC_INTERVAL_MS ?? 60_000
	);

	constructor(
		@Inject('YOUTUBE_QUOTA_USAGE_REPOSITORY')
		private readonly youtubeQuotaUsageRepo: typeof YoutubeQuotaUsage
	) { }

	async onModuleInit() {
		await this.youtubeQuotaUsageRepo.sync();
	}

	resolvePool(endpointLabel: string): YoutubeQuotaPool {
		return endpointLabel.startsWith('youtubeanalytics.') ? 'youtube_analytics' : 'youtube_data_v3';
	}

	private resolveUnitCost(endpointLabel: string, pool: YoutubeQuotaPool) {
		if (pool === 'youtube_analytics') {
			return 1;
		}
		const match = YoutubeQuotaService.DATA_V3_UNIT_COSTS.find((entry) =>
			endpointLabel.startsWith(entry.prefix)
		);
		if (!match) {
			this.logger.warn(
				`No documented unit cost configured for YouTube Data v3 endpoint "${endpointLabel}"; defaulting to 1 unit. Verify against Google's quota cost docs and add it to DATA_V3_UNIT_COSTS if this endpoint costs more.`
			);
		}
		return match?.cost ?? 1;
	}

	private getBudget(pool: YoutubeQuotaPool) {
		return pool === 'youtube_analytics' ? this.dailyAnalyticsCallBudget : this.dailyDataV3UnitBudget;
	}

	/** YouTube quota resets at midnight Pacific Time, not UTC or server-local time. */
	private getUsageDate() {
		return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
	}

	async assertBudgetAvailable(endpointLabel: string) {
		const pool = this.resolvePool(endpointLabel);
		const budget = this.getBudget(pool);
		const reserve = Math.floor(budget * (this.reserveBufferPercent / 100));
		const totalUsed = await this.getCachedUsedToday(pool);

		if (totalUsed >= budget - reserve) {
			throw new YoutubeQuotaExceededError(
				`YouTube ${pool} quota budget nearly exhausted for ${this.getUsageDate()} (${totalUsed}/${budget} used, ${reserve} reserved); refusing ${endpointLabel}`
			);
		}
	}

	/** Hits the DB at most once per pool per resync interval (and on the first check after
	 * a process starts, or after midnight Pacific rolls the usage date over) — every other
	 * call reads the in-memory running total. The DB total is the sum of every instance's
	 * increments, so a resync is what makes another instance's spend count here. */
	private async getCachedUsedToday(pool: YoutubeQuotaPool) {
		const usageDate = this.getUsageDate();
		const cached = this.inMemoryUsage.get(pool);
		if (
			cached &&
			cached.usageDate === usageDate &&
			Date.now() - cached.syncedAt < this.usageResyncIntervalMs
		) {
			return cached.unitsUsed;
		}

		const rows = await this.youtubeQuotaUsageRepo.findAll({
			where: { usageDate, pool },
			raw: true
		});
		const totalUsed = (rows as any[]).reduce((sum, row) => sum + Number(row.unitsUsed || 0), 0);
		this.inMemoryUsage.set(pool, { usageDate, unitsUsed: totalUsed, syncedAt: Date.now() });
		return totalUsed;
	}

	/** Budget left for this pool today, so ingestion code can decide whether it can still
	 * afford lower-priority (warm/cool tier) work without waiting for the hard refusal in
	 * `assertBudgetAvailable`. */
	async getRemainingBudget(pool: YoutubeQuotaPool) {
		const budget = this.getBudget(pool);
		const used = await this.getCachedUsedToday(pool);
		return Math.max(0, budget - used);
	}

	async recordUsage(endpointLabel: string) {
		const pool = this.resolvePool(endpointLabel);
		const unitCost = this.resolveUnitCost(endpointLabel, pool);
		const usageDate = this.getUsageDate();

		// Update the in-memory total synchronously first — this is what every subsequent
		// assertBudgetAvailable/getRemainingBudget call in this process actually reads, so
		// the gating decision is correct immediately regardless of how the DB write below
		// resolves.
		const cached = await this.getCachedUsedToday(pool);
		this.inMemoryUsage.set(pool, {
			usageDate,
			unitsUsed: cached + unitCost,
			syncedAt: this.inMemoryUsage.get(pool)?.syncedAt ?? Date.now()
		});

		// Persist for cross-instance visibility, the /quota/status breakdown, and so a
		// restart mid-day resumes from real usage rather than zero. Still awaited (a genuine
		// DB outage should surface, not vanish), but it's now a single lightweight,
		// already-atomic increment/insert — the expensive read-and-sum this replaced no
		// longer runs on every call, only once per pool per day via getCachedUsedToday.
		const existing = await this.youtubeQuotaUsageRepo.findOne({
			where: { usageDate, pool, endpoint: endpointLabel }
		});

		if (existing) {
			await existing.increment({ unitsUsed: unitCost, callCount: 1 });
			await existing.update({ lastCallAt: new Date() });
			return;
		}

		await this.youtubeQuotaUsageRepo.create({
			usageDate,
			pool,
			endpoint: endpointLabel,
			unitsUsed: unitCost,
			callCount: 1,
			lastCallAt: new Date()
		});
	}

	isQuotaExceededError(error: any) {
		// Our own proactive refusal (assertBudgetAvailable, thrown before any HTTP call is
		// even made) is also a quota-exceeded condition, not a generic error — it has no
		// .response to inspect, so it has to be recognized by type rather than by status code.
		if (error instanceof YoutubeQuotaExceededError) {
			return true;
		}

		const status = error?.response?.status;
		// Google APIs return 403 for daily quota/project-level limits, but 429 for some
		// rate-limit-style throttling (e.g. userRateLimitExceeded) — both are "back off",
		// not just 403.
		if (status !== 403 && status !== 429) {
			return false;
		}
		const reasons = (error?.response?.data?.error?.errors || [])
			.map((entry: any) => String(entry?.reason || '').toLowerCase());
		const message = String(error?.response?.data?.error?.message || '').toLowerCase();
		return (
			reasons.includes('quotaexceeded') ||
			reasons.includes('dailylimitexceeded') ||
			reasons.includes('userratelimitexceeded') ||
			reasons.includes('ratelimitexceeded') ||
			message.includes('quota')
		);
	}

	async getStatus() {
		const usageDate = this.getUsageDate();
		const rows = await this.youtubeQuotaUsageRepo.findAll({
			where: { usageDate },
			raw: true
		});

		const pools: Record<string, { unitsUsed: number; callCount: number; budget: number }> = {
			youtube_data_v3: { unitsUsed: 0, callCount: 0, budget: this.dailyDataV3UnitBudget },
			youtube_analytics: { unitsUsed: 0, callCount: 0, budget: this.dailyAnalyticsCallBudget }
		};

		for (const row of rows as any[]) {
			if (!pools[row.pool]) {
				continue;
			}
			pools[row.pool].unitsUsed += Number(row.unitsUsed || 0);
			pools[row.pool].callCount += Number(row.callCount || 0);
		}

		return {
			statusCode: 200,
			message: 'YouTube quota usage fetched successfully',
			data: {
				usageDate,
				pools,
				endpoints: rows
			}
		};
	}
}
