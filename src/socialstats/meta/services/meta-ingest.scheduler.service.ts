import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IngestionControlService } from '../../shared/services/ingestion-control.service';
import { IngestionRunsService } from '../../shared/services/ingestion-runs.service';
import { MetaAuthService } from './meta-auth.service';
import { MetaBackfillWalkService } from './meta-backfill-walk.service';
import { MetaIngestService } from './meta-ingest.service';

const ONE_TIME_META_BACKFILL_START_AT = new Date('2026-09-18T14:30:00.000Z');
const ONE_TIME_META_BACKFILL_DEADLINE = '2026-09-21T08:00:00Z';
const ONE_TIME_META_BACKFILL_WINDOW_END = new Date(ONE_TIME_META_BACKFILL_DEADLINE);

@Injectable()
export class MetaIngestSchedulerService implements OnModuleInit {
	private readonly logger = new Logger(MetaIngestSchedulerService.name);
	private oneTimeBackfillTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly metaAuthService: MetaAuthService,
		private readonly metaIngestService: MetaIngestService,
		private readonly metaBackfillWalkService: MetaBackfillWalkService,
		private readonly ingestionRunsService: IngestionRunsService,
		private readonly ingestionControlService: IngestionControlService
	) { }

	async onModuleInit() {
		await this.scheduleOneTimeBackfillWalkStart();
	}

	private isEnabled(flagName: string) {
		const value = String(process.env[flagName] ?? 'true').trim().toLowerCase();
		return !['false', '0', 'off', 'no'].includes(value);
	}

	private isStagingEnvironment() {
		return String(process.env.NODE_ENVIRONMENT || '').trim().toUpperCase() === 'STAGING';
	}

	private async scheduleOneTimeBackfillWalkStart() {
		if (!this.isStagingEnvironment()) {
			return;
		}

		const walkStatus = this.metaBackfillWalkService.getStatus();
		if (walkStatus.status === 'running' || walkStatus.status === 'completed') {
			this.logger.log(
				`Skipping one-time Meta backfill walk auto-start because walk status is ${walkStatus.status}.`
			);
			return;
		}

		const now = Date.now();
		if (now >= ONE_TIME_META_BACKFILL_WINDOW_END.getTime()) {
			return;
		}

		const delayMs = ONE_TIME_META_BACKFILL_START_AT.getTime() - now;
		if (delayMs <= 0) {
			await this.startOneTimeBackfillWalk('startup-after-target');
			return;
		}

		this.logger.log(
			`Scheduling one-time Meta backfill walk auto-start for ${ONE_TIME_META_BACKFILL_START_AT.toISOString()}.`
		);
		this.oneTimeBackfillTimer = setTimeout(() => {
			this.startOneTimeBackfillWalk('scheduled-time').catch((error: any) => {
				this.logger.error(
					`One-time Meta backfill walk auto-start failed: ${error?.message || 'Unknown error'}`
				);
			});
		}, delayMs);
	}

	private async startOneTimeBackfillWalk(trigger: 'startup-after-target' | 'scheduled-time') {
		if (this.oneTimeBackfillTimer) {
			clearTimeout(this.oneTimeBackfillTimer);
			this.oneTimeBackfillTimer = null;
		}

		const walkStatus = this.metaBackfillWalkService.getStatus();
		if (walkStatus.status === 'running' || walkStatus.status === 'completed') {
			this.logger.log(
				`Skipping one-time Meta backfill walk ${trigger} trigger because walk status is ${walkStatus.status}.`
			);
			return;
		}

		await this.metaBackfillWalkService.start({
			pageId: '153145408089596',
			instagramId: '17841400714806415',
			chunkDays: 14,
			intervalMinutes: 30,
			deadline: ONE_TIME_META_BACKFILL_DEADLINE
		});
		this.logger.log(
			`Started one-time Meta backfill walk (${trigger}) for pageId=153145408089596 instagramId=17841400714806415.`
		);
	}

	private getDefaultPageId() {
		return this.metaAuthService.getConfigurationStatus().data.defaultPageId || undefined;
	}

	private async shouldSkip(jobType: string) {
		const pauseState = await this.ingestionControlService.isPaused('meta', jobType);
		if (pauseState.paused) {
			this.logger.warn(
				`Skipping scheduled Meta ${jobType} ingest: paused at ${pauseState.scope} scope${
					pauseState.reason ? ` (${pauseState.reason})` : ''
				}`
			);
			return true;
		}

		const activeRun = await this.ingestionRunsService.findActiveRun({
			platform: 'meta',
			jobType,
			entityType: 'page'
		});

		if (!activeRun) {
			return false;
		}

		this.logger.warn(
			`Skipping scheduled Meta ${jobType} ingest because run ${activeRun.id} is still active`
		);
		return true;
	}

	@Cron('5 0 * * *')
	async ingestProfileSnapshot() {
		if (!this.isEnabled('META_PROFILE_SNAPSHOT_CRON_ENABLED')) {
			return;
		}
		if (await this.shouldSkip('profile_snapshot')) {
			return;
		}

		try {
			await this.metaIngestService.ingestProfileSnapshot({
				pageId: this.getDefaultPageId(),
				scope: 'automatic',
				runType: 'incremental',
				triggerSource: 'cron'
			});
		} catch (error: any) {
			this.logger.error(
				`Scheduled Meta profile snapshot failed: ${error?.message || 'Unknown error'}`
			);
		}
	}

	@Cron('10 */6 * * *')
	async ingestContentSnapshot() {
		if (!this.isEnabled('META_CONTENT_SNAPSHOT_CRON_ENABLED')) {
			return;
		}
		if (await this.shouldSkip('content_snapshot')) {
			return;
		}

		try {
			await this.metaIngestService.ingestContentSnapshot({
				pageId: this.getDefaultPageId(),
				scope: 'automatic',
				runType: 'incremental',
				triggerSource: 'cron'
			});
		} catch (error: any) {
			this.logger.error(
				`Scheduled Meta content snapshot failed: ${error?.message || 'Unknown error'}`
			);
		}
	}

	@Cron('20 * * * *')
	async ingestStorySnapshot() {
		if (!this.isEnabled('META_STORY_SNAPSHOT_CRON_ENABLED')) {
			return;
		}
		if (await this.shouldSkip('story_snapshot')) {
			return;
		}

		try {
			await this.metaIngestService.ingestStorySnapshot({
				pageId: this.getDefaultPageId(),
				scope: 'automatic',
				runType: 'incremental',
				triggerSource: 'cron'
			});
		} catch (error: any) {
			this.logger.error(
				`Scheduled Meta story snapshot failed: ${error?.message || 'Unknown error'}`
			);
		}
	}

	@Cron('35 0 * * *')
	async ingestGeoSnapshot() {
		if (!this.isEnabled('META_GEO_SNAPSHOT_CRON_ENABLED')) {
			return;
		}
		if (await this.shouldSkip('geo_snapshot')) {
			return;
		}

		try {
			await this.metaIngestService.ingestGeoSnapshot({
				pageId: this.getDefaultPageId(),
				scope: 'automatic',
				runType: 'incremental',
				triggerSource: 'cron'
			});
		} catch (error: any) {
			this.logger.error(
				`Scheduled Meta geo snapshot failed: ${error?.message || 'Unknown error'}`
			);
		}
	}
}
