import { logToErrorFile } from '../../../common/logger';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IngestionControlService } from '../../shared/services/ingestion-control.service';
import {
	IngestionRunConflictError,
	IngestionRunsService
} from '../../shared/services/ingestion-runs.service';
import { LinkedinAuthService } from './linkedin-auth.service';
import { LinkedinService } from './linkedin.service';

@Injectable()
export class LinkedinIngestService {
	private readonly logger = new Logger(LinkedinIngestService.name);

	constructor(
		private readonly linkedinService: LinkedinService,
		private readonly linkedinAuthService: LinkedinAuthService,
		private readonly ingestionRunsService: IngestionRunsService,
		private readonly ingestionControlService: IngestionControlService
	) { }

	private async shouldSkipScheduledRun(jobType: string) {
		// Not configured yet is the expected state before LinkedIn API access + an admin's
		// OAuth consent exist — skip quietly rather than creating a "failed" ingestion run for
		// every cron tick, which would make the ingestion status dashboard look broken instead
		// of just "not set up yet".
		const status = this.linkedinAuthService.getConfigurationStatus();
		if (!status.organizationConfigured || !status.clientIdConfigured) {
			return true;
		}

		const pauseState = await this.ingestionControlService.isPaused('linkedin', jobType);
		if (pauseState.paused) {
			this.logger.warn(
				`Skipping scheduled LinkedIn ${jobType} ingest: paused at ${pauseState.scope} scope${
					pauseState.reason ? ` (${pauseState.reason})` : ''
				}`
			);
			return true;
		}

		const activeRun = await this.ingestionRunsService.findActiveRun({
			platform: 'linkedin',
			jobType,
			entityType: 'organization'
		});
		if (!activeRun) {
			return false;
		}

		this.logger.warn(`Skipping scheduled LinkedIn ${jobType} ingest because run ${activeRun.id} is still active`);
		return true;
	}

	/**
	 * `shouldSkipScheduledRun` is only a cheap pre-check; `createRun` is the atomic claim.
	 * Losing the claim to another instance is a normal skip for a cron, not a failure.
	 */
	private async claimRun(jobType: string) {
		try {
			return await this.ingestionRunsService.createRun({
				platform: 'linkedin',
				entityType: 'organization',
				entityId: 'default',
				jobType,
				runType: 'incremental',
				triggerSource: 'cron'
			});
		} catch (err) {
			if (err instanceof IngestionRunConflictError) {
				this.logger.warn(`Skipping scheduled LinkedIn ${jobType} ingest: ${err.message}`);
				return null;
			}
			throw err;
		}
	}

	private async runJob(jobType: string, run: () => Promise<unknown>) {
		if (await this.shouldSkipScheduledRun(jobType)) {
			return;
		}
		const ingestionRun = await this.claimRun(jobType);
		if (!ingestionRun) {
			return;
		}
		try {
			const result = await run();
			await this.ingestionRunsService.completeRun(ingestionRun.id, {
				entityId: 'default',
				recordsFetched: 1,
				recordsProcessed: 1,
				recordsUpserted: 1,
				metadata: (result as any)?.data ?? {}
			});
		} catch (err) {
			logToErrorFile(err, `Error while ingesting LinkedIn ${jobType} from cron`);
			await this.ingestionRunsService.failRun(ingestionRun.id, err, { entityId: 'default' });
		}
	}

	@Cron('10 1 * * *')
	async ingestLinkedinOrganizationOverview() {
		await this.runJob('organization_overview', () => this.linkedinService.getOrganizationOverview());
	}

	@Cron('20 1 * * *')
	async ingestLinkedinFollowerStatistics() {
		await this.runJob('follower_statistics', () => this.linkedinService.getFollowerStatistics());
	}

	@Cron('30 1 * * *')
	async ingestLinkedinPageStatistics() {
		await this.runJob('page_statistics', () => this.linkedinService.getPageStatistics());
	}

	@Cron('40 1 * * *')
	async ingestLinkedinShareStatistics() {
		await this.runJob('share_statistics', () => this.linkedinService.getShareStatistics());
	}
}
