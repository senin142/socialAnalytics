import {
	YoutubeReachStats,
	YoutubeReportingJobState,
	YoutubeVideoDailyStats,
	YoutubeVideoTrafficSourceStats
} from '../../../database/entity';
import { logToErrorFile } from '../../../common/logger';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { DataTypes, Op } from 'sequelize';
import { YoutubeAuthService } from './youtube-auth.service';

const REPORTING_API_BASE = 'https://youtubereporting.googleapis.com/v1';

/** A parsed CSV row: header name → cell. */
type CsvRecord = Record<string, string>;

interface BulkReportConfig {
	reportTypeId: string;
	jobName: string;
	/** Headers that must be present for the file to be the report we think it is. */
	requiredHeaders: string[];
	/** Turns the raw records of one report file into DB rows (aggregating as needed)
	 * and writes them; returns the number of rows written. */
	ingest: (records: CsvRecord[], reportId: string) => Promise<number>;
}

export interface BulkReportSyncSummary {
	reportsProcessed: number;
	rowsUpserted: number;
	perReport: Record<string, { reportsProcessed: number; rowsUpserted: number; error?: string }>;
}

/**
 * Owns the YouTube Reporting API jobs. Unlike the interactive Analytics API used elsewhere
 * in this module (one query per call, quota per call, top-N only), Reporting jobs deliver a
 * daily CSV covering EVERY video for ~zero quota, roughly 24–48h behind. For each report
 * type in BULK_REPORTS this service creates the job once, polls for report files newer
 * than the last one processed, downloads and parses each CSV, and hands the records to
 * that report's ingester. Job/cursor state lives in YoutubeReportingJobState, one row per
 * report type.
 *
 * `channel_reach_basic_a1` is the original job here (thumbnail impressions/CTR, which the
 * Analytics API does not expose at all); `channel_basic_a3` and
 * `channel_traffic_source_a3` were added once the API was enabled for the project.
 */
@Injectable()
export class YoutubeReachService implements OnModuleInit {
	private readonly logger = new Logger(YoutubeReachService.name);

	private readonly bulkReports: BulkReportConfig[] = [
		{
			reportTypeId: 'channel_reach_basic_a1',
			jobName: 'CNBC Arabia channel reach (basic)',
			requiredHeaders: ['date', 'video_id', 'video_thumbnail_impressions'],
			ingest: (records, reportId) => this.ingestReachRecords(records, reportId)
		},
		{
			reportTypeId: 'channel_basic_a3',
			jobName: 'CNBC Arabia channel basic (per video per day)',
			requiredHeaders: ['date', 'video_id', 'views'],
			ingest: (records, reportId) => this.ingestVideoDailyRecords(records, reportId)
		},
		{
			reportTypeId: 'channel_traffic_source_a3',
			jobName: 'CNBC Arabia traffic sources (per video per day)',
			requiredHeaders: ['date', 'video_id', 'traffic_source_type', 'views'],
			ingest: (records, reportId) => this.ingestTrafficSourceRecords(records, reportId)
		}
	];

	constructor(
		private readonly youtubeAuthService: YoutubeAuthService,
		@Inject('YOUTUBE_REACH_STATS_REPOSITORY')
		private readonly youtubeReachStatsRepo: typeof YoutubeReachStats,
		@Inject('YOUTUBE_REPORTING_JOB_STATE_REPOSITORY')
		private readonly youtubeReportingJobStateRepo: typeof YoutubeReportingJobState,
		@Inject('YOUTUBE_VIDEO_DAILY_STATS_REPOSITORY')
		private readonly youtubeVideoDailyStatsRepo: typeof YoutubeVideoDailyStats,
		@Inject('YOUTUBE_VIDEO_TRAFFIC_SOURCE_STATS_REPOSITORY')
		private readonly youtubeVideoTrafficSourceStatsRepo: typeof YoutubeVideoTrafficSourceStats
	) { }

	async onModuleInit() {
		try {
			await this.youtubeReachStatsRepo.sync();
			await this.youtubeReportingJobStateRepo.sync();
			await this.youtubeVideoDailyStatsRepo.sync();
			await this.youtubeVideoTrafficSourceStatsRepo.sync();
			await this.ensureVideoDailyStatsColumnWidths();
		} catch (err) {
			logToErrorFile(err, 'Error while syncing YouTube reporting tables');
			throw err;
		}
	}

	/**
	 * `.sync()` only creates a table on first boot; it never alters an existing column, so a
	 * widened DECIMAL on the entity (see YoutubeVideoDailyStats) needs an explicit ALTER here
	 * to actually reach a database that already has the table. Safe to run every boot —
	 * changeColumn to an identical type is a no-op.
	 */
	private async ensureVideoDailyStatsColumnWidths() {
		const sequelizeInstance = this.youtubeVideoDailyStatsRepo.sequelize;
		if (!sequelizeInstance) {
			return;
		}

		const queryInterface = sequelizeInstance.getQueryInterface();
		await queryInterface.changeColumn('YoutubeVideoDailyStats', 'averageViewDurationPercentage', {
			type: DataTypes.DECIMAL(10, 3),
			allowNull: true
		});
	}

	/**
	 * Syncs every registered report type. One report type failing (job creation refused,
	 * a malformed file) is recorded in `perReport` and does not stop the others; the run is
	 * only a failure when nothing could be synced at all.
	 */
	async syncNewReports(): Promise<BulkReportSyncSummary> {
		const token = await this.youtubeAuthService.getAccessToken();
		const summary: BulkReportSyncSummary = { reportsProcessed: 0, rowsUpserted: 0, perReport: {} };
		const failures: string[] = [];

		for (const config of this.bulkReports) {
			try {
				const result = await this.syncReportType(config, token.accessToken);
				summary.perReport[config.reportTypeId] = result;
				summary.reportsProcessed += result.reportsProcessed;
				summary.rowsUpserted += result.rowsUpserted;
			} catch (err: any) {
				const message = err?.response?.data?.error?.message || err?.message || 'Unknown error';
				this.logger.error(`YouTube bulk report ${config.reportTypeId} sync failed: ${message}`);
				logToErrorFile(err, `Error while syncing YouTube bulk report ${config.reportTypeId}`);
				summary.perReport[config.reportTypeId] = { reportsProcessed: 0, rowsUpserted: 0, error: message };
				failures.push(`${config.reportTypeId}: ${message}`);
			}
		}

		if (failures.length === this.bulkReports.length) {
			throw new Error(`All YouTube bulk report syncs failed — ${failures.join(' | ')}`);
		}
		return summary;
	}

	private async syncReportType(config: BulkReportConfig, accessToken: string) {
		const jobId = await this.ensureReportingJob(config, accessToken);
		let state = await this.youtubeReportingJobStateRepo.findOne({
			where: { reportTypeId: config.reportTypeId }
		});

		const listParams: Record<string, string> = {};
		if (state?.lastProcessedCreateTime) {
			listParams.createdAfter = new Date(state.lastProcessedCreateTime).toISOString();
		}

		const reportsResponse = await axios.get(`${REPORTING_API_BASE}/jobs/${jobId}/reports`, {
			headers: { Authorization: `Bearer ${accessToken}` },
			params: listParams
		});

		const reports = ((reportsResponse.data?.reports || []) as Array<{
			id: string;
			downloadUrl: string;
			createTime: string;
		}>)
			.slice()
			.sort((a, b) => new Date(a.createTime).getTime() - new Date(b.createTime).getTime());

		let reportsProcessed = 0;
		let rowsUpserted = 0;

		for (const report of reports) {
			if (state?.lastProcessedReportId === report.id) {
				continue;
			}

			const records = await this.downloadAndParseReport(report.downloadUrl, accessToken, config);
			rowsUpserted += await config.ingest(records, report.id);
			reportsProcessed++;
			this.logger.log(
				`YouTube bulk report ${config.reportTypeId}: processed report ${report.id} (${records.length} records)`
			);

			if (state) {
				await state.update({
					lastProcessedReportId: report.id,
					lastProcessedCreateTime: report.createTime,
					lastSyncedAt: new Date()
				});
			} else {
				state = await this.youtubeReportingJobStateRepo.create({
					reportTypeId: config.reportTypeId,
					jobId,
					lastProcessedReportId: report.id,
					lastProcessedCreateTime: report.createTime,
					lastSyncedAt: new Date()
				});
			}
		}

		return { reportsProcessed, rowsUpserted };
	}

	async getAggregatedImpressions(startDate: string, endDate: string, maxResults: number) {
		const rows = await this.youtubeReachStatsRepo.findAll({
			where: {
				statDate: { [Op.gte]: startDate, [Op.lte]: endDate }
			},
			raw: true
		});

		const byVideo = new Map<string, { impressions: number; weightedCtrSum: number }>();
		for (const row of rows as unknown as Array<{
			videoId: string;
			videoThumbnailImpressions: number;
			videoThumbnailImpressionsClickRate: string | null;
		}>) {
			const entry = byVideo.get(row.videoId) || { impressions: 0, weightedCtrSum: 0 };
			const impressions = Number(row.videoThumbnailImpressions || 0);
			entry.impressions += impressions;
			entry.weightedCtrSum += impressions * Number(row.videoThumbnailImpressionsClickRate || 0);
			byVideo.set(row.videoId, entry);
		}

		return Array.from(byVideo.entries())
			.map(([videoId, entry]) => ({
				videoId,
				impressions: entry.impressions,
				impressionClickThroughRate: entry.impressions ? entry.weightedCtrSum / entry.impressions : 0
			}))
			.sort((a, b) => b.impressions - a.impressions)
			.slice(0, maxResults);
	}

	private async ensureReportingJob(config: BulkReportConfig, accessToken: string): Promise<string> {
		const existingState = await this.youtubeReportingJobStateRepo.findOne({
			where: { reportTypeId: config.reportTypeId }
		});
		if (existingState?.jobId) {
			return existingState.jobId;
		}

		// A job may already exist (created by hand, or by another instance) — adopt it rather
		// than creating a duplicate, which YouTube would happily allow.
		const listResponse = await axios.get(`${REPORTING_API_BASE}/jobs`, {
			headers: { Authorization: `Bearer ${accessToken}` },
			params: { includeSystemManaged: true }
		});
		const jobs = (listResponse.data?.jobs || []) as Array<{ id: string; reportTypeId: string }>;
		let job = jobs.find((entry) => entry.reportTypeId === config.reportTypeId);

		if (!job) {
			this.logger.log(`Creating YouTube Reporting API job for ${config.reportTypeId}`);
			const createResponse = await axios.post(
				`${REPORTING_API_BASE}/jobs`,
				{ reportTypeId: config.reportTypeId, name: config.jobName },
				{ headers: { Authorization: `Bearer ${accessToken}` } }
			);
			job = createResponse.data;
		}

		if (existingState) {
			await existingState.update({ jobId: job.id });
		} else {
			await this.youtubeReportingJobStateRepo.create({
				reportTypeId: config.reportTypeId,
				jobId: job.id
			});
		}

		return job.id;
	}

	private async downloadAndParseReport(
		downloadUrl: string,
		accessToken: string,
		config: BulkReportConfig
	): Promise<CsvRecord[]> {
		const response = await axios.get(downloadUrl, {
			headers: { Authorization: `Bearer ${accessToken}` },
			responseType: 'text',
			transformResponse: (data) => data,
			// channel_basic files run to tens of MB for a large catalog.
			maxContentLength: 256 * 1024 * 1024,
			maxBodyLength: 256 * 1024 * 1024
		});
		return this.parseCsv(String(response.data || ''), config);
	}

	/** Reporting API CSVs are plain comma-separated with a header row and no quoting of the
	 * numeric/ID columns we use; unknown columns are carried through by name and ignored. */
	private parseCsv(csv: string, config: BulkReportConfig): CsvRecord[] {
		const lines = csv
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);
		if (!lines.length) {
			return [];
		}

		const headers = lines[0].split(',').map((header) => header.trim());
		const missing = config.requiredHeaders.filter((header) => !headers.includes(header));
		if (missing.length) {
			throw new Error(
				`Unexpected ${config.reportTypeId} CSV header (missing ${missing.join(', ')}): ${headers.join(',')}`
			);
		}

		return lines.slice(1).map((line) => {
			const cols = line.split(',');
			const record: CsvRecord = {};
			headers.forEach((header, index) => {
				record[header] = cols[index] ?? '';
			});
			return record;
		});
	}

	private async ingestReachRecords(records: CsvRecord[], reportId: string): Promise<number> {
		const now = new Date();
		const rows = records
			.filter((record) => record.video_id && record.date)
			.map((record) => ({
				channelId: record.channel_id || null,
				videoId: record.video_id,
				statDate: record.date,
				videoThumbnailImpressions: Number(record.video_thumbnail_impressions || 0),
				videoThumbnailImpressionsClickRate:
					record.video_thumbnail_impressions_ctr !== undefined
						? String(Number(record.video_thumbnail_impressions_ctr || 0))
						: null,
				reportId,
				fetchedAt: now
			}));

		return await this.bulkUpsert(this.youtubeReachStatsRepo, rows, ['videoId', 'statDate'], [
			'channelId', 'videoThumbnailImpressions', 'videoThumbnailImpressionsClickRate',
			'reportId', 'fetchedAt', 'updatedAt'
		]);
	}

	/**
	 * channel_basic_a3 is one row per video × country × live_or_on_demand × subscribed_status.
	 * Sums collapse to the video-day; average view duration is re-weighted by views.
	 */
	private async ingestVideoDailyRecords(records: CsvRecord[], reportId: string): Promise<number> {
		type Agg = {
			channelId: string | null; videoId: string; statDate: string;
			views: number; liveViews: number; subscribedViews: number; redViews: number;
			watchTimeMinutes: number; durationWeighted: number; durationPctWeighted: number;
			likes: number; dislikes: number; comments: number; shares: number;
			subscribersGained: number; subscribersLost: number;
			videosAddedToPlaylists: number; videosRemovedFromPlaylists: number;
		};
		const byVideoDay = new Map<string, Agg>();
		const num = (value: string | undefined) => Number(value || 0) || 0;

		for (const record of records) {
			if (!record.video_id || !record.date) continue;
			const key = `${record.video_id}|${record.date}`;
			const agg = byVideoDay.get(key) || {
				channelId: record.channel_id || null, videoId: record.video_id, statDate: record.date,
				views: 0, liveViews: 0, subscribedViews: 0, redViews: 0,
				watchTimeMinutes: 0, durationWeighted: 0, durationPctWeighted: 0,
				likes: 0, dislikes: 0, comments: 0, shares: 0,
				subscribersGained: 0, subscribersLost: 0,
				videosAddedToPlaylists: 0, videosRemovedFromPlaylists: 0
			};
			const views = num(record.views);
			agg.views += views;
			if (String(record.live_or_on_demand || '').toUpperCase() === 'LIVE') agg.liveViews += views;
			if (String(record.subscribed_status || '').toUpperCase() === 'SUBSCRIBED') agg.subscribedViews += views;
			agg.redViews += num(record.red_views);
			agg.watchTimeMinutes += num(record.watch_time_minutes);
			agg.durationWeighted += views * num(record.average_view_duration_seconds);
			agg.durationPctWeighted += views * num(record.average_view_duration_percentage);
			agg.likes += num(record.likes);
			agg.dislikes += num(record.dislikes);
			agg.comments += num(record.comments);
			agg.shares += num(record.shares);
			agg.subscribersGained += num(record.subscribers_gained);
			agg.subscribersLost += num(record.subscribers_lost);
			agg.videosAddedToPlaylists += num(record.videos_added_to_playlists);
			agg.videosRemovedFromPlaylists += num(record.videos_removed_from_playlists);
			byVideoDay.set(key, agg);
		}

		const now = new Date();
		const rows = Array.from(byVideoDay.values()).map((agg) => ({
			channelId: agg.channelId,
			videoId: agg.videoId,
			statDate: agg.statDate,
			views: agg.views,
			liveViews: agg.liveViews,
			subscribedViews: agg.subscribedViews,
			redViews: agg.redViews,
			watchTimeMinutes: agg.watchTimeMinutes.toFixed(3),
			averageViewDurationSeconds: agg.views ? (agg.durationWeighted / agg.views).toFixed(3) : null,
			averageViewDurationPercentage: agg.views ? (agg.durationPctWeighted / agg.views).toFixed(3) : null,
			likes: agg.likes,
			dislikes: agg.dislikes,
			comments: agg.comments,
			shares: agg.shares,
			subscribersGained: agg.subscribersGained,
			subscribersLost: agg.subscribersLost,
			videosAddedToPlaylists: agg.videosAddedToPlaylists,
			videosRemovedFromPlaylists: agg.videosRemovedFromPlaylists,
			reportId,
			fetchedAt: now
		}));

		return await this.bulkUpsert(this.youtubeVideoDailyStatsRepo, rows, ['videoId', 'statDate'], [
			'channelId', 'views', 'liveViews', 'subscribedViews', 'redViews', 'watchTimeMinutes',
			'averageViewDurationSeconds', 'averageViewDurationPercentage', 'likes', 'dislikes',
			'comments', 'shares', 'subscribersGained', 'subscribersLost', 'videosAddedToPlaylists',
			'videosRemovedFromPlaylists', 'reportId', 'fetchedAt', 'updatedAt'
		]);
	}

	/** channel_traffic_source_a3 → per video per day per traffic_source_type. */
	private async ingestTrafficSourceRecords(records: CsvRecord[], reportId: string): Promise<number> {
		const byKey = new Map<string, { channelId: string | null; videoId: string; statDate: string; trafficSourceType: string; views: number; watchTimeMinutes: number }>();
		for (const record of records) {
			if (!record.video_id || !record.date || !record.traffic_source_type) continue;
			const key = `${record.video_id}|${record.date}|${record.traffic_source_type}`;
			const agg = byKey.get(key) || {
				channelId: record.channel_id || null, videoId: record.video_id, statDate: record.date,
				trafficSourceType: record.traffic_source_type, views: 0, watchTimeMinutes: 0
			};
			agg.views += Number(record.views || 0) || 0;
			agg.watchTimeMinutes += Number(record.watch_time_minutes || 0) || 0;
			byKey.set(key, agg);
		}

		const now = new Date();
		const rows = Array.from(byKey.values()).map((agg) => ({
			...agg,
			watchTimeMinutes: agg.watchTimeMinutes.toFixed(3),
			reportId,
			fetchedAt: now
		}));
		return await this.bulkUpsert(this.youtubeVideoTrafficSourceStatsRepo, rows, ['videoId', 'statDate', 'trafficSourceType'], [
			'channelId', 'views', 'watchTimeMinutes', 'reportId', 'fetchedAt', 'updatedAt'
		]);
	}

	/** INSERT … ON CONFLICT DO UPDATE in chunks. `conflictAttributes` must be passed explicitly:
	 * without it, Sequelize infers the conflict target from every unique key on the model
	 * (including the surrogate `id`), which does not match any actual Postgres constraint. */
	private async bulkUpsert(
		repo: { bulkCreate: Function },
		rows: Record<string, unknown>[],
		conflictAttributes: string[],
		updateOnDuplicate: string[]
	) {
		const chunkSize = 500;
		for (let index = 0; index < rows.length; index += chunkSize) {
			await repo.bulkCreate(rows.slice(index, index + chunkSize), { updateOnDuplicate, conflictAttributes });
		}
		return rows.length;
	}
}
