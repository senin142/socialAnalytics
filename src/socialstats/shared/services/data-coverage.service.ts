import { SocialStatsDataCoverage } from '../../../database/entity';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';

export type DataCoverageStatus =
	| 'available'
	| 'unavailable_permission'
	| 'unavailable_unsupported'
	| 'unavailable_insufficient_data'
	| 'unavailable_quota'
	| 'unavailable_error'
	| 'not_yet_attempted';

type RecordAttemptInput = {
	platform: string;
	jobType: string;
	metricKey: string;
	scope?: string | null;
	success: boolean;
	status?: DataCoverageStatus;
	reason?: string | null;
};

@Injectable()
export class DataCoverageService implements OnModuleInit {
	constructor(
		@Inject('SOCIAL_STATS_DATA_COVERAGE_REPOSITORY')
		private readonly dataCoverageRepo: typeof SocialStatsDataCoverage
	) { }

	async onModuleInit() {
		await this.dataCoverageRepo.sync();
	}

	async recordAttempt(input: RecordAttemptInput) {
		const scope = input.scope ?? null;
		const now = new Date();
		// This table stores the latest known availability per metric/scope, not a full event
		// history, so the status endpoint can answer "is this data obtainable right now?"
		// with one row lookup per metric.
		const existing = await this.dataCoverageRepo.findOne({
			where: {
				platform: input.platform,
				jobType: input.jobType,
				metricKey: input.metricKey,
				scope
			}
		});

		if (input.success) {
			const payload = {
				status: 'available' as DataCoverageStatus,
				reason: null,
				lastAttemptAt: now,
				lastSuccessAt: now,
				consecutiveFailures: 0
			};
			if (existing) {
				await existing.update(payload);
				return existing;
			}
			return await this.dataCoverageRepo.create({
				platform: input.platform,
				jobType: input.jobType,
				metricKey: input.metricKey,
				scope,
				...payload
			});
		}

		const status = input.status ?? 'unavailable_error';
		const payload = {
			status,
			reason: input.reason ?? null,
			lastAttemptAt: now,
			consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1
		};
		if (existing) {
			await existing.update(payload);
			return existing;
		}
		return await this.dataCoverageRepo.create({
			platform: input.platform,
			jobType: input.jobType,
			metricKey: input.metricKey,
			scope,
			lastSuccessAt: null,
			...payload
		});
	}

	async getCoverage(platform?: string) {
		const rows = await this.dataCoverageRepo.findAll({
			where: platform ? { platform } : undefined,
			order: [
				['platform', 'ASC'],
				['jobType', 'ASC'],
				['metricKey', 'ASC']
			],
			raw: true
		});

		const grouped: Record<string, Record<string, any[]>> = {};
		for (const row of rows as any[]) {
			grouped[row.platform] = grouped[row.platform] ?? {};
			grouped[row.platform][row.jobType] = grouped[row.platform][row.jobType] ?? [];
			grouped[row.platform][row.jobType].push({
				metricKey: row.metricKey,
				scope: row.scope,
				status: row.status,
				reason: row.reason,
				lastAttemptAt: row.lastAttemptAt,
				lastSuccessAt: row.lastSuccessAt,
				consecutiveFailures: row.consecutiveFailures
			});
		}

		return grouped;
	}
}
