export type ContentTier = 'hot' | 'warm' | 'cool';

const HOT_MAX_AGE_DAYS = Number(process.env.CONTENT_TIER_HOT_MAX_AGE_DAYS ?? 2);
const WARM_MAX_AGE_DAYS = Number(process.env.CONTENT_TIER_WARM_MAX_AGE_DAYS ?? 7);
const WARM_CADENCE_MINUTES = Number(process.env.CONTENT_TIER_WARM_CADENCE_MINUTES ?? 1440);
const COOL_CADENCE_MINUTES = Number(process.env.CONTENT_TIER_COOL_CADENCE_MINUTES ?? 10080);

/**
 * Buckets a piece of content by age so ingestion can prioritize freshest-first: new
 * content ("hot") always gets the expensive per-item refresh, older content ("warm"/"cool")
 * only needs it on a slower cadence since its metrics have largely settled. Boundaries are
 * env-overridable and shared by both Meta and YouTube ingestion so tuning lives in one place.
 */
export function classifyContentTier(publishedAt: Date | string | null | undefined, now: Date = new Date()): ContentTier {
	if (!publishedAt) {
		return 'hot';
	}

	const publishedTime = publishedAt instanceof Date ? publishedAt.getTime() : new Date(publishedAt).getTime();
	if (!Number.isFinite(publishedTime)) {
		return 'hot';
	}

	const ageDays = Math.max(0, (now.getTime() - publishedTime) / (24 * 60 * 60 * 1000));
	if (ageDays <= HOT_MAX_AGE_DAYS) {
		return 'hot';
	}
	if (ageDays <= WARM_MAX_AGE_DAYS) {
		return 'warm';
	}
	return 'cool';
}

function getTierCadenceMinutes(tier: ContentTier): number {
	if (tier === 'hot') {
		return 0;
	}
	return tier === 'warm' ? WARM_CADENCE_MINUTES : COOL_CADENCE_MINUTES;
}

/** True if this item hasn't been refreshed recently enough for its tier (or never). */
export function isRefreshDue(
	tier: ContentTier,
	lastRefreshedAt: Date | string | null | undefined,
	now: Date = new Date()
): boolean {
	if (tier === 'hot' || !lastRefreshedAt) {
		return true;
	}

	const lastRefreshedTime =
		lastRefreshedAt instanceof Date ? lastRefreshedAt.getTime() : new Date(lastRefreshedAt).getTime();
	if (!Number.isFinite(lastRefreshedTime)) {
		return true;
	}

	const minutesSinceRefresh = (now.getTime() - lastRefreshedTime) / 60_000;
	return minutesSinceRefresh >= getTierCadenceMinutes(tier);
}

export type TierSummary = {
	hot: number;
	warm: number;
	cool: number;
	skippedForBudget: number;
};

export function createEmptyTierSummary(): TierSummary {
	return { hot: 0, warm: 0, cool: 0, skippedForBudget: 0 };
}
