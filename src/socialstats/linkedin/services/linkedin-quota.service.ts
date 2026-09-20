import { LinkedinApiUsage } from '../../../database/entity';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';

export class LinkedinQuotaExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LinkedinQuotaExceededError';
	}
}

/**
 * LinkedIn's Community Management API Development Tier defaults to 500 requests/app/day AND
 * 100 requests/member/day (Standard Tier raises both after approval). LinkedIn does not expose
 * a quota-status endpoint like YouTube's, so this is tracked locally, purely to avoid silently
 * burning through the daily allowance and getting rate-limited for the rest of the day.
 *
 * Both caps are enforced against the same counter, and that is deliberate: every call this
 * module makes is authorized by the one admin token LinkedinAuthService stores, so each request
 * is simultaneously one against the app's daily cap and one against that single member's. The
 * member cap is five times tighter, so it is the one that actually binds — tracking only the
 * app budget (as this did originally) reports "within quota" at 100 calls while LinkedIn has
 * already started refusing them. If this ever grows to multiple authorized members, the counter
 * needs a member dimension rather than this min().
 */
@Injectable()
export class LinkedinQuotaService implements OnModuleInit {
	private readonly dailyAppRequestBudget = Number(
		process.env.LINKEDIN_DAILY_APP_REQUEST_BUDGET ?? 500
	);
	private readonly dailyMemberRequestBudget = Number(
		process.env.LINKEDIN_DAILY_MEMBER_REQUEST_BUDGET ?? 100
	);
	private readonly reserveBufferPercent = Number(
		process.env.LINKEDIN_QUOTA_RESERVE_PERCENT ?? 10
	);
	private inMemoryUsage: { usageDate: string; callCount: number } | null = null;

	constructor(
		@Inject('LINKEDIN_API_USAGE_REPOSITORY')
		private readonly linkedinApiUsageRepo: typeof LinkedinApiUsage
	) { }

	async onModuleInit() {
		await this.linkedinApiUsageRepo.sync();
	}

	private getUsageDate() {
		return new Date().toISOString().slice(0, 10);
	}

	private async getCachedUsedToday() {
		const usageDate = this.getUsageDate();
		if (this.inMemoryUsage && this.inMemoryUsage.usageDate === usageDate) {
			return this.inMemoryUsage.callCount;
		}

		const rows = await this.linkedinApiUsageRepo.findAll({ where: { usageDate }, raw: true });
		const total = (rows as any[]).reduce((sum, row) => sum + Number(row.callCount || 0), 0);
		this.inMemoryUsage = { usageDate, callCount: total };
		return total;
	}

	async assertBudgetAvailable(endpointLabel: string) {
		const effectiveBudget = this.getEffectiveBudget();
		const reserve = Math.floor(effectiveBudget * (this.reserveBufferPercent / 100));
		const used = await this.getCachedUsedToday();
		if (used >= effectiveBudget - reserve) {
			const boundBy =
				effectiveBudget === this.dailyMemberRequestBudget ? 'per-member' : 'per-app';
			throw new LinkedinQuotaExceededError(
				`LinkedIn API daily request budget nearly exhausted for ${this.getUsageDate()} (${used}/${effectiveBudget} used against the ${boundBy} cap, ${reserve} reserved); refusing ${endpointLabel}`
			);
		}
	}

	private getEffectiveBudget() {
		return Math.min(this.dailyAppRequestBudget, this.dailyMemberRequestBudget);
	}

	async recordUsage(endpointLabel: string) {
		const usageDate = this.getUsageDate();
		const cached = await this.getCachedUsedToday();
		this.inMemoryUsage = { usageDate, callCount: cached + 1 };

		const existing = await this.linkedinApiUsageRepo.findOne({
			where: { usageDate, endpoint: endpointLabel }
		});
		if (existing) {
			await existing.increment({ callCount: 1 });
			await existing.update({ lastCallAt: new Date() });
			return;
		}

		await this.linkedinApiUsageRepo.create({
			usageDate,
			endpoint: endpointLabel,
			callCount: 1,
			lastCallAt: new Date()
		});
	}

	isQuotaExceededError(error: any) {
		if (error instanceof LinkedinQuotaExceededError) {
			return true;
		}
		const status = error?.response?.status;
		return status === 429;
	}

	async getStatus() {
		const usageDate = this.getUsageDate();
		const rows = await this.linkedinApiUsageRepo.findAll({ where: { usageDate }, raw: true });
		const callCount = (rows as any[]).reduce((sum, row) => sum + Number(row.callCount || 0), 0);

		return {
			statusCode: 200,
			message: 'LinkedIn API usage fetched successfully',
			data: {
				usageDate,
				budget: this.getEffectiveBudget(),
				appBudget: this.dailyAppRequestBudget,
				memberBudget: this.dailyMemberRequestBudget,
				callCount,
				endpoints: rows
			}
		};
	}
}
