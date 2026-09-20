import { Inject, Injectable, Logger } from '@nestjs/common';
import { MetaRateLimitEvents } from '../../../database/entity';
import { Op } from 'sequelize';

type CooldownEntry = {
	until: number;
	reason: string;
};

export class MetaRateLimitPauseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MetaRateLimitPauseError';
	}
}

@Injectable()
export class MetaRateLimitService {
	private readonly logger = new Logger(MetaRateLimitService.name);
	private readonly cooldowns = new Map<string, CooldownEntry>();
	private readonly globalCooldownKey = '__global__';
	private readonly defaultCooldownSeconds = Number(
		process.env.META_RATE_LIMIT_COOLDOWN_SECONDS ?? 900
	);
	private readonly usageThresholdPercent = Number(
		process.env.META_RATE_LIMIT_USAGE_THRESHOLD_PERCENT ?? 90
	);
	private lastObservedUsagePercent: number | null = null;
	private lastObservedUsageAt: Date | null = null;
	// The cooldown map above is per process, but the Meta app/page budget is shared by every
	// instance. Events are already persisted for the status endpoint; reading the recent ones
	// back — at most once per interval, and only when nothing is paused locally — is what
	// lets a pause learned by one instance stop the others from spending into it.
	private lastSharedCooldownSyncAt = 0;
	private readonly sharedCooldownResyncIntervalMs = Number(
		process.env.META_RATE_LIMIT_RESYNC_INTERVAL_MS ?? 30_000
	);

	constructor(
		@Inject('META_RATE_LIMIT_EVENTS_REPOSITORY')
		private readonly metaRateLimitRepo: typeof MetaRateLimitEvents
	) { }

	async recordRateLimitEvent(payload: {
		source: string;
		endpoint: string;
		errorCode?: number | null;
		errorSubcode?: number | null;
		isTransient?: boolean;
		retryAfterSeconds?: number | null;
		appUsage?: string | null;
		pageUsage?: string | null;
		rawJson?: string | null;
		}) {
		const retryAfterSeconds = payload.retryAfterSeconds ?? 60;
		this.setCooldown(payload.endpoint, retryAfterSeconds, 'rate_limit');
		this.setCooldown(this.globalCooldownKey, retryAfterSeconds, 'rate_limit');

		return await this.metaRateLimitRepo.create({
			source: payload.source,
			endpoint: payload.endpoint,
			errorCode: payload.errorCode ?? null,
			errorSubcode: payload.errorSubcode ?? null,
			isTransient: payload.isTransient ?? false,
			retryAfterSeconds,
			appUsage: payload.appUsage ?? null,
			pageUsage: payload.pageUsage ?? null,
			rawJson: payload.rawJson ?? null
		});
	}

	async assertRequestAllowed(endpoint: string) {
		let activeCooldown =
			this.getActiveCooldown(this.globalCooldownKey) || this.getActiveCooldown(endpoint);
		if (!activeCooldown) {
			await this.syncSharedCooldowns();
			activeCooldown =
				this.getActiveCooldown(this.globalCooldownKey) || this.getActiveCooldown(endpoint);
		}
		if (!activeCooldown) {
			return;
		}

		const message = `Meta API paused for ${endpoint} until ${new Date(
			activeCooldown.until
		).toISOString()} (${activeCooldown.reason})`;
		this.logger.warn(message);
		throw new MetaRateLimitPauseError(message);
	}

	async observeUsage(payload: {
		source: string;
		endpoint: string;
		appUsage?: string | null;
		pageUsage?: string | null;
		businessUsage?: string | null;
	}) {
		const usageValues = [
			...this.extractUsageValues(payload.appUsage),
			...this.extractUsageValues(payload.pageUsage),
			...this.extractUsageValues(payload.businessUsage)
		];
		const maxObservedUsage = usageValues.length ? Math.max(...usageValues) : null;
		if (maxObservedUsage !== null && Number.isFinite(maxObservedUsage)) {
			this.lastObservedUsagePercent = maxObservedUsage;
			this.lastObservedUsageAt = new Date();
		}

		if (
			maxObservedUsage === null ||
			!Number.isFinite(maxObservedUsage) ||
			maxObservedUsage < this.usageThresholdPercent
		) {
			return;
		}

		const existingGlobalCooldown = this.getActiveCooldown(this.globalCooldownKey);
		if (existingGlobalCooldown?.reason.startsWith('usage_threshold_')) {
			return;
		}

		this.setCooldown(
			this.globalCooldownKey,
			this.defaultCooldownSeconds,
			`usage_threshold_${Math.round(maxObservedUsage)}`
		);
		this.logger.warn(
			`Meta API usage threshold reached for ${payload.endpoint}: ${maxObservedUsage}% >= ${this.usageThresholdPercent}%`
		);

		await this.metaRateLimitRepo.create({
			source: payload.source,
			endpoint: payload.endpoint,
			errorCode: null,
			errorSubcode: null,
			isTransient: false,
			retryAfterSeconds: this.defaultCooldownSeconds,
			appUsage: payload.appUsage ?? null,
			pageUsage: payload.pageUsage ?? null,
			rawJson: JSON.stringify({
				type: 'usage_threshold_pause',
				thresholdPercent: this.usageThresholdPercent,
				maxObservedUsage,
				businessUsage: payload.businessUsage ?? null
			})
		});
	}

	/** Latest observed usage percentage (app/page/business, whichever is highest), for
	 * ingestion code that wants to back off on lower-priority work before the hard cooldown
	 * threshold is actually hit, rather than only reacting after the fact. */
	getUsageSnapshot() {
		return {
			percent: this.lastObservedUsagePercent,
			updatedAt: this.lastObservedUsageAt
		};
	}

	async getStatus() {
		const latestEvents = await this.metaRateLimitRepo.findAll({
			order: [['occurredAt', 'DESC']],
			limit: 20,
			raw: true
		});

		return {
			statusCode: 200,
			message: 'Meta rate limit status fetched successfully',
			data: {
				activeCooldowns: Array.from(this.cooldowns.entries()).map(
					([endpoint, cooldown]) => ({
						endpoint,
						cooldownUntil: new Date(cooldown.until).toISOString(),
						active: cooldown.until > Date.now(),
						reason: cooldown.reason
					})
				),
				usageThresholdPercent: this.usageThresholdPercent,
				recentEvents: latestEvents
			}
		};
	}

	/**
	 * Seeds the local cooldown map from events any instance persisted whose retry window
	 * is still open. Idempotent for our own events (setCooldown keeps the later expiry), and
	 * a DB problem here must never block a Meta call — it just means we fall back to what
	 * this process learned on its own.
	 */
	private async syncSharedCooldowns() {
		const now = Date.now();
		if (now - this.lastSharedCooldownSyncAt < this.sharedCooldownResyncIntervalMs) {
			return;
		}
		this.lastSharedCooldownSyncAt = now;

		try {
			// No event can still be active if it is older than the longest pause we ever set.
			const longestPauseMs = Math.max(this.defaultCooldownSeconds, 60) * 1000;
			const rows = await this.metaRateLimitRepo.findAll({
				where: { occurredAt: { [Op.gt]: new Date(now - longestPauseMs) } },
				order: [['occurredAt', 'DESC']],
				limit: 50,
				raw: true
			});

			for (const row of rows as any[]) {
				const until =
					new Date(row.occurredAt).getTime() + Number(row.retryAfterSeconds ?? 60) * 1000;
				if (until <= now) {
					continue;
				}
				const remainingSeconds = Math.ceil((until - now) / 1000);
				const isThresholdPause = String(row.rawJson || '').includes('usage_threshold_pause');
				// Threshold pauses are always global; the reason prefix is what stops
				// observeUsage from stacking a fresh 15-minute pause on top of a shared one.
				const reason = isThresholdPause ? 'usage_threshold_shared' : 'rate_limit';
				this.setCooldown(this.globalCooldownKey, remainingSeconds, reason);
				if (!isThresholdPause && row.endpoint) {
					this.setCooldown(String(row.endpoint), remainingSeconds, reason);
				}
			}
		} catch (error: any) {
			this.logger.warn(
				`Unable to sync shared Meta rate-limit cooldowns: ${error?.message || 'Unknown error'}`
			);
		}
	}

	private setCooldown(endpoint: string, retryAfterSeconds: number, reason: string) {
		const nextUntil = Date.now() + retryAfterSeconds * 1000;
		const existing = this.cooldowns.get(endpoint);
		if (existing && existing.until >= nextUntil) {
			return;
		}
		this.cooldowns.set(endpoint, {
			until: nextUntil,
			reason
		});
	}

	private getActiveCooldown(endpoint: string) {
		const cooldown = this.cooldowns.get(endpoint);
		if (!cooldown) {
			return null;
		}
		if (cooldown.until <= Date.now()) {
			this.cooldowns.delete(endpoint);
			return null;
		}
		return cooldown;
	}

	private extractUsageValues(value?: string | null): number[] {
		if (!value) {
			return [];
		}

		try {
			const parsed = JSON.parse(value);
			return this.flattenNumericValues(parsed);
		} catch {
			return [];
		}
	}

	private flattenNumericValues(input: unknown): number[] {
		if (typeof input === 'number' && Number.isFinite(input)) {
			return [input];
		}
		if (Array.isArray(input)) {
			return input.flatMap((entry) => this.flattenNumericValues(entry));
		}
		if (input && typeof input === 'object') {
			return Object.values(input).flatMap((entry) => this.flattenNumericValues(entry));
		}
		return [];
	}
}
