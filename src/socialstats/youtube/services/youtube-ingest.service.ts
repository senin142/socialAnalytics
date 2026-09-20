import { logToErrorFile } from '../../../common/logger';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IngestionControlService } from '../../shared/services/ingestion-control.service';
import {
	IngestionRunConflictError,
	IngestionRunsService
} from '../../shared/services/ingestion-runs.service';
import { YoutubeReachService } from './youtube-reach.service';
import { YoutubeService } from './youtube.service';

@Injectable()
export class YoutubeIngestService {
	private readonly logger = new Logger(YoutubeIngestService.name);

	constructor(
		private youtubeService: YoutubeService,
		private readonly youtubeReachService: YoutubeReachService,
		private readonly ingestionRunsService: IngestionRunsService,
		private readonly ingestionControlService: IngestionControlService
	) { }

	private async shouldSkipScheduledRun(jobType: string) {
		const pauseState = await this.ingestionControlService.isPaused('youtube', jobType);
		if (pauseState.paused) {
			this.logger.warn(
				`Skipping scheduled YouTube ${jobType} ingest: paused at ${pauseState.scope} scope${
					pauseState.reason ? ` (${pauseState.reason})` : ''
				}`
			);
			return true;
		}

		const activeRun = await this.ingestionRunsService.findActiveRun({
			platform: 'youtube',
			jobType,
			entityType: 'channel'
		});

		if (!activeRun) {
			return false;
		}

		this.logger.warn(
			`Skipping scheduled YouTube ${jobType} ingest because run ${activeRun.id} is still active`
		);
		return true;
	}

	/**
	 * `shouldSkipScheduledRun` is only a cheap pre-check; `createRun` is the atomic one.
	 * When another instance won the same tick, that's a normal skip, not an error.
	 */
	private async claimRun(jobType: string, extra?: { leaseTtlMinutes?: number }) {
		try {
			return await this.ingestionRunsService.createRun({
				platform: 'youtube',
				entityType: 'channel',
				entityId: 'default',
				jobType,
				runType: 'incremental',
				triggerSource: 'cron',
				...(extra || {})
			});
		} catch (err) {
			if (err instanceof IngestionRunConflictError) {
				this.logger.warn(`Skipping scheduled YouTube ${jobType} ingest: ${err.message}`);
				return null;
			}
			throw err;
		}
	}

	@Cron('0 * * * *')
	async ingestYoutubeStats() {
		if (await this.shouldSkipScheduledRun('channel_stats')) {
			return;
		}
		const run = await this.claimRun('channel_stats');
		if (!run) {
			return;
		}
		try {
			const result = await this.youtubeService.ingestChannelStats();
			const channelId = result?.data?.channelId || 'default';
			await this.ingestionRunsService.completeRun(run.id, {
				entityId: channelId,
				recordsFetched: 1,
				recordsProcessed: 1,
				recordsUpserted: 1,
				metadata: {
					action: result?.action ?? null,
					channelId
				}
			});
		} catch (err) {
			logToErrorFile(err, 'Error while ingesting YouTube stats from cron');
			await this.ingestionRunsService.failRun(run.id, err, {
				entityId: 'default'
			});
		}
	}

	@Cron('*/2 * * * *')
	async ingestYoutubeLiveViewerSnapshots() {
		if (await this.shouldSkipScheduledRun('live_viewers')) {
			return;
		}
		// Two 15s-bounded API calls and a couple of DB writes; the default 30-minute
		// lease meant one orphaned run silenced this every-2-minutes job for 15 ticks.
		const run = await this.claimRun('live_viewers', { leaseTtlMinutes: 5 });
		if (!run) {
			return;
		}
		try {
			const result = await this.youtubeService.ingestCurrentLiveViewerSnapshot();
			await this.ingestionRunsService.completeRun(run.id, {
				entityId: result?.data?.channelId || 'default',
				recordsFetched: result?.data?.ingested ? 1 : 0,
				recordsProcessed: result?.data?.ingested ? 1 : 0,
				recordsUpserted: result?.data?.ingested ? 1 : 0,
				metadata: result?.data ?? {}
			});
		} catch (err) {
			logToErrorFile(err, 'Error while ingesting YouTube live viewer snapshots from cron');
			await this.ingestionRunsService.failRun(run.id, err, {
				entityId: 'default'
			});
		}
	}

	@Cron('15 0 * * *')
	async ingestYoutubeDailyVideoRetentionStats() {
		if (await this.shouldSkipScheduledRun('video_retention')) {
			return;
		}
		const run = await this.claimRun('video_retention');
		if (!run) {
			return;
		}
		try {
			const result = await this.youtubeService.ingestDailyVideoRetentionStats();
			await this.ingestionRunsService.completeRun(run.id, {
				entityId: result?.data?.channelId || 'default',
				scopeStartDate: result?.data?.range?.startDate ?? null,
				scopeEndDate: result?.data?.range?.endDate ?? null,
				recordsFetched: Number(result?.data?.topVideosConsidered || 0),
				recordsProcessed:
					Number(result?.data?.createdCount || 0) + Number(result?.data?.updatedCount || 0),
				recordsUpserted:
					Number(result?.data?.createdCount || 0) + Number(result?.data?.updatedCount || 0),
				metadata: result?.data ?? {}
			});
		} catch (err) {
			logToErrorFile(
				err,
				'Error while ingesting YouTube daily video retention stats from cron'
			);
			await this.ingestionRunsService.failRun(run.id, err, {
				entityId: 'default'
			});
		}
	}

	@Cron('45 0 * * *')
	async ingestYoutubeDailyGeoDeviceStats() {
		if (await this.shouldSkipScheduledRun('geo_device')) {
			return;
		}
		const run = await this.claimRun('geo_device');
		if (!run) {
			return;
		}
		try {
			const result = await this.youtubeService.ingestDailyGeoDeviceStats();
			const counts = result?.data?.counts ?? {};
			const countValues = Object.values(counts) as Array<{
				created?: number;
				updated?: number;
			}>;
			const totalUpserts = countValues.reduce((sum: number, value) => {
				const created = Number(value?.created || 0);
				const updated = Number(value?.updated || 0);
				return sum + created + updated;
			}, 0);
			await this.ingestionRunsService.completeRun(run.id, {
				entityId: result?.data?.channelId || 'default',
				scopeStartDate: result?.data?.startDate ?? null,
				scopeEndDate: result?.data?.endDate ?? null,
				recordsFetched: Number(result?.data?.totalDaysIngested || 0),
				recordsProcessed: totalUpserts,
				recordsUpserted: totalUpserts,
				metadata: result?.data ?? {}
			});
		} catch (err) {
			logToErrorFile(
				err,
				'Error while ingesting YouTube daily geo/device stats from cron'
			);
			await this.ingestionRunsService.failRun(run.id, err, {
				entityId: 'default'
			});
		}
	}

	/**
	 * Polls the YouTube Reporting API for newly generated bulk report files and ingests
	 * them into the local reporting tables. Reports are generated by Google roughly once a
	 * day with up to ~48h latency, so a daily poll is sufficient.
	 */
	@Cron('30 3 * * *')
	async ingestYoutubeReachReports() {
		if (await this.shouldSkipScheduledRun('reach_reports')) {
			return;
		}
		const run = await this.claimRun('reach_reports');
		if (!run) {
			return;
		}
		try {
			const result = await this.youtubeReachService.syncNewReports();
			await this.ingestionRunsService.completeRun(run.id, {
				entityId: 'default',
				recordsFetched: result.reportsProcessed,
				recordsProcessed: result.reportsProcessed,
				recordsUpserted: result.rowsUpserted,
				metadata: {
					reportsProcessed: result.reportsProcessed,
					rowsUpserted: result.rowsUpserted,
					perReport: result.perReport
				}
			});
		} catch (err) {
			logToErrorFile(err, 'Error while ingesting YouTube reach reports from cron');
			await this.ingestionRunsService.failRun(run.id, err, {
				entityId: 'default'
			});
		}
	}

	/**
	 * Timeseries/traffic-sources/traffic-source-detail/top-videos/demographics/impressions-CTR
	 * are otherwise only fetched live when someone opens the dashboard, with a 10-minute cache.
	 * This proactively captures a daily snapshot (persisted by each method itself via
	 * `persistAnalyticsSnapshot`) so history accumulates even with zero dashboard traffic, and
	 * the first dashboard load each day is already warm. No explicit cache-bypass is needed:
	 * by the time this runs (once/day) any prior 10-minute cache entry has long since expired.
	 */
	@Cron('20 0 * * *')
	async ingestDailyAnalyticsSnapshot() {
		if (await this.shouldSkipScheduledRun('analytics_snapshot')) {
			return;
		}
		const run = await this.claimRun('analytics_snapshot');
		if (!run) {
			return;
		}

		const reports: Array<{ name: string; run: () => Promise<unknown> }> = [
			{ name: 'timeseries', run: () => this.youtubeService.getAnalyticsTimeseries() },
			{ name: 'traffic_sources', run: () => this.youtubeService.getTrafficSources() },
			{ name: 'traffic_source_detail', run: () => this.youtubeService.getTrafficSourceDetail() },
			{ name: 'top_videos', run: () => this.youtubeService.getTopVideos() },
			{ name: 'audience_demographics', run: () => this.youtubeService.getAudienceDemographics() },
			{ name: 'impressions_ctr', run: () => this.youtubeService.getImpressionsAndCtr() },
			{ name: 'content_type', run: () => this.youtubeService.getContentTypeBreakdown() },
			{ name: 'live_vs_on_demand', run: () => this.youtubeService.getLiveVsOnDemand() },
			{ name: 'viewer_segments', run: () => this.youtubeService.getViewerSegments() },
			{ name: 'monetization', run: () => this.youtubeService.getMonetization() }
		];

		const succeeded: string[] = [];
		const failed: Array<{ name: string; reason: string }> = [];

		for (const report of reports) {
			try {
				await report.run();
				succeeded.push(report.name);
			} catch (err) {
				failed.push({ name: report.name, reason: this.ingestionRunsService.getErrorMessage(err) });
			}
		}

		if (failed.length === reports.length) {
			await this.ingestionRunsService.failRun(
				run.id,
				new Error(failed.map((entry) => `${entry.name}: ${entry.reason}`).join(' | ')),
				{ entityId: 'default' }
			);
			return;
		}

		await this.ingestionRunsService.completeRun(run.id, {
			entityId: 'default',
			recordsFetched: reports.length,
			recordsProcessed: succeeded.length,
			recordsUpserted: succeeded.length,
			metadata: { succeeded, failed }
		});
	}
}
