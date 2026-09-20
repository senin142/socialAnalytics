import { logToErrorFile } from '../../../common/logger';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IngestionControlService } from '../../shared/services/ingestion-control.service';
import {
	IngestionRunConflictError,
	IngestionRunsService
} from '../../shared/services/ingestion-runs.service';
import { TiktokAuthService } from './tiktok-auth.service';
import { TiktokService } from './tiktok.service';

@Injectable()
export class TiktokIngestService {
	private readonly logger = new Logger(TiktokIngestService.name);

	constructor(
		private readonly tiktokService: TiktokService,
		private readonly tiktokAuthService: TiktokAuthService,
		private readonly ingestionRunsService: IngestionRunsService,
		private readonly ingestionControlService: IngestionControlService
	) { }

	/**
	 * TikTok access tokens expire after 24 hours, so unlike the other platforms in this module
	 * the token cannot be left to the read path alone — a day with no dashboard traffic would
	 * let it lapse silently. This runs well inside that window so a single failed attempt
	 * (network blip, TikTok 5xx) still leaves several more before anything breaks.
	 *
	 * Deliberately not wrapped in an ingestion run: it moves no analytics data, and recording
	 * it as one would bury the actual ingest jobs in the status dashboard.
	 */
	@Cron('0 */6 * * *')
	async refreshTiktokAccessToken() {
		if (!this.isConfigured()) {
			return;
		}
		try {
			const result = await this.tiktokAuthService.refreshIfNeeded();
			if (result.refreshed) {
				this.logger.log(`Refreshed TikTok access token for ${result.openId}, now valid until ${result.expiresAt}`);
			}
		} catch (err) {
			logToErrorFile(err, 'Error while refreshing the TikTok access token from cron');
			this.logger.error(`TikTok token refresh failed: ${(err as Error).message}`);
		}
	}

	@Cron('10 2 * * *')
	async ingestTiktokAccountOverview() {
		await this.runJob('account_overview', () => this.tiktokService.getAccountOverview());
	}

	@Cron('20 2 * * *')
	async ingestTiktokVideoStats() {
		await this.runJob('video_stats', () => this.tiktokService.getVideoStats());
	}

	/**
	 * Retention sweep required by TikTok's Developer Terms — drops content the creator has
	 * removed and ages out snapshots past the retention window. Runs after the ingest jobs so
	 * the deletion flags they set are acted on the same night.
	 */
	@Cron('45 3 * * *')
	async purgeTiktokStaleContent() {
		if (!this.isConfigured()) {
			return;
		}
		try {
			await this.tiktokService.purgeStaleContent();
		} catch (err) {
			logToErrorFile(err, 'Error while purging stale TikTok content from cron');
		}
	}

	private isConfigured() {
		// Not configured yet is the expected state before a TikTok app exists and the account
		// holder has consented — skip quietly rather than logging a failure on every tick.
		const status = this.tiktokAuthService.getConfigurationStatus();
		return status.clientKeyConfigured && status.clientSecretConfigured;
	}

	private async shouldSkipScheduledRun(jobType: string) {
		if (!this.isConfigured()) {
			return true;
		}

		const pauseState = await this.ingestionControlService.isPaused('tiktok', jobType);
		if (pauseState.paused) {
			this.logger.warn(
				`Skipping scheduled TikTok ${jobType} ingest: paused at ${pauseState.scope} scope${
					pauseState.reason ? ` (${pauseState.reason})` : ''
				}`
			);
			return true;
		}

		const activeRun = await this.ingestionRunsService.findActiveRun({
			platform: 'tiktok',
			jobType,
			entityType: 'account'
		});
		if (!activeRun) {
			return false;
		}

		this.logger.warn(`Skipping scheduled TikTok ${jobType} ingest because run ${activeRun.id} is still active`);
		return true;
	}

	/**
	 * `shouldSkipScheduledRun` is only a cheap pre-check; `createRun` is the atomic claim.
	 * Losing the claim to another instance is a normal skip for a cron, not a failure.
	 */
	private async claimRun(jobType: string) {
		try {
			return await this.ingestionRunsService.createRun({
				platform: 'tiktok',
				entityType: 'account',
				entityId: 'default',
				jobType,
				runType: 'incremental',
				triggerSource: 'cron'
			});
		} catch (err) {
			if (err instanceof IngestionRunConflictError) {
				this.logger.warn(`Skipping scheduled TikTok ${jobType} ingest: ${err.message}`);
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
			logToErrorFile(err, `Error while ingesting TikTok ${jobType} from cron`);
			await this.ingestionRunsService.failRun(ingestionRun.id, err, { entityId: 'default' });
		}
	}
}
