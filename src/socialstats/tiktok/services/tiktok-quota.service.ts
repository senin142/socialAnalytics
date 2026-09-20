import { TiktokApiUsage } from '../../../database/entity';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';

export class TiktokQuotaExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TiktokQuotaExceededError';
	}
}

/**
 * TikTok's Display API budget is shaped differently from the other platforms in this module:
 * the binding limit is per-MINUTE (roughly 600 requests/minute per client_key, measured over a
 * one-minute sliding window), not per-day like LinkedIn's or unit-costed like YouTube's quota.
 * Exceeding it throttles the whole app, so the minute window is enforced locally before each
 * call rather than discovered through 429s.
 *
 * The daily budget on top of it is ours, not TikTok's — a backstop so a wedged loop can't burn
 * the account's standing with the platform overnight. Both are env-tunable because TikTok
 * adjusts per-app limits on request.
 */
@Injectable()
export class TiktokQuotaService implements OnModuleInit {
	private readonly requestsPerMinute = Number(process.env.TIKTOK_REQUESTS_PER_MINUTE ?? 600);
	private readonly dailyRequestBudget = Number(process.env.TIKTOK_DAILY_REQUEST_BUDGET ?? 10000);
	private readonly reserveBufferPercent = Number(process.env.TIKTOK_QUOTA_RESERVE_PERCENT ?? 10);

	private readonly recentCallTimestamps: number[] = [];
	private inMemoryUsage: { usageDate: string; callCount: number } | null = null;

	constructor(
		@Inject('TIKTOK_API_USAGE_REPOSITORY')
		private readonly tiktokApiUsageRepo: typeof TiktokApiUsage
	) { }

	async onModuleInit() {
		await this.tiktokApiUsageRepo.sync();
	}

	async assertBudgetAvailable(endpointLabel: string) {
		this.pruneMinuteWindow();
		if (this.recentCallTimestamps.length >= this.requestsPerMinute) {
			throw new TiktokQuotaExceededError(
				`TikTok per-minute rate limit reached (${this.recentCallTimestamps.length}/${this.requestsPerMinute} in the last 60s); refusing ${endpointLabel}`
			);
		}

		const reserve = Math.floor(this.dailyRequestBudget * (this.reserveBufferPercent / 100));
		const used = await this.getCachedUsedToday();
		if (used >= this.dailyRequestBudget - reserve) {
			throw new TiktokQuotaExceededError(
				`TikTok daily request budget nearly exhausted for ${this.getUsageDate()} (${used}/${this.dailyRequestBudget} used, ${reserve} reserved); refusing ${endpointLabel}`
			);
		}
	}

	async recordUsage(endpointLabel: string) {
		this.pruneMinuteWindow();
		this.recentCallTimestamps.push(Date.now());

		const usageDate = this.getUsageDate();
		const cached = await this.getCachedUsedToday();
		this.inMemoryUsage = { usageDate, callCount: cached + 1 };

		const existing = await this.tiktokApiUsageRepo.findOne({
			where: { usageDate, endpoint: endpointLabel }
		});
		if (existing) {
			await existing.increment({ callCount: 1 });
			await existing.update({ lastCallAt: new Date() });
			return;
		}

		await this.tiktokApiUsageRepo.create({
			usageDate,
			endpoint: endpointLabel,
			callCount: 1,
			lastCallAt: new Date()
		});
	}

	isQuotaExceededError(error: any) {
		if (error instanceof TiktokQuotaExceededError) {
			return true;
		}
		if (error?.response?.status === 429) {
			return true;
		}
		// The v2 API answers HTTP 200 with the failure in the body, so the string code is the
		// only reliable signal for a throttle.
		return error?.tiktokErrorCode === 'rate_limit_exceeded';
	}

	async getStatus() {
		const usageDate = this.getUsageDate();
		const rows = await this.tiktokApiUsageRepo.findAll({ where: { usageDate }, raw: true });
		const callCount = (rows as any[]).reduce((sum, row) => sum + Number(row.callCount || 0), 0);

		this.pruneMinuteWindow();

		return {
			statusCode: 200,
			message: 'TikTok API usage fetched successfully',
			data: {
				usageDate,
				dailyBudget: this.dailyRequestBudget,
				callCount,
				requestsPerMinuteLimit: this.requestsPerMinute,
				callsInLastMinute: this.recentCallTimestamps.length,
				endpoints: rows
			}
		};
	}

	private pruneMinuteWindow() {
		const cutoff = Date.now() - 60_000;
		while (this.recentCallTimestamps.length && this.recentCallTimestamps[0] < cutoff) {
			this.recentCallTimestamps.shift();
		}
	}

	private getUsageDate() {
		return new Date().toISOString().slice(0, 10);
	}

	private async getCachedUsedToday() {
		const usageDate = this.getUsageDate();
		if (this.inMemoryUsage && this.inMemoryUsage.usageDate === usageDate) {
			return this.inMemoryUsage.callCount;
		}

		const rows = await this.tiktokApiUsageRepo.findAll({ where: { usageDate }, raw: true });
		const total = (rows as any[]).reduce((sum, row) => sum + Number(row.callCount || 0), 0);
		this.inMemoryUsage = { usageDate, callCount: total };
		return total;
	}
}
