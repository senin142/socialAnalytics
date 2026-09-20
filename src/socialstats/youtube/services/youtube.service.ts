import {
	CountryList,
	YoutubeAnalyticsSnapshots,
	YoutubeChannelStats,
	YoutubeGeoDeviceDimensionType,
	YoutubeGeoDeviceStats,
	YoutubeLiveViewerStats,
	YoutubeVideoDailyStats,
	YoutubeVideoGeoStats,
	YoutubeVideoRetentionStats,
	YoutubeVideoTrafficSourceStats
} from '../../../database/entity';
import { logToErrorFile } from '../../../common/logger';
import {
	BadRequestException,
	BadGatewayException,
	HttpStatus,
	Inject,
	Injectable,
	Logger,
	NotFoundException,
	OnModuleInit
} from '@nestjs/common';
import axios from 'axios';
import { Op } from 'sequelize';
import { DataCoverageService } from '../../shared/services/data-coverage.service';
import { classifyContentTier, createEmptyTierSummary, isRefreshDue } from '../../shared/utils/refresh-tiering';
import { YoutubeAuthService } from './youtube-auth.service';
import { YoutubeQuotaPool, YoutubeQuotaService } from './youtube-quota.service';
import { YoutubeReachService } from './youtube-reach.service';

@Injectable()
export class YoutubeService implements OnModuleInit {
	private readonly logger = new Logger(YoutubeService.name);
	private readonly responseCache = new Map<string, { expiresAt: number; value: any }>();
	private readonly requestTimeoutMs = Number(process.env.YOUTUBE_HTTP_TIMEOUT_MS ?? 15000);

	constructor(
		private youtubeAuthService: YoutubeAuthService,
		private readonly youtubeQuotaService: YoutubeQuotaService,
		private readonly dataCoverageService: DataCoverageService,
		private readonly youtubeReachService: YoutubeReachService,
		@Inject('YOUTUBE_CHANNEL_STATS_REPOSITORY')
		private youtubeChannelRepo: typeof YoutubeChannelStats,
		@Inject('YOUTUBE_VIDEO_RETENTION_STATS_REPOSITORY')
		private youtubeVideoRetentionRepo: typeof YoutubeVideoRetentionStats,
		@Inject('YOUTUBE_VIDEO_GEO_STATS_REPOSITORY')
		private youtubeVideoGeoStatsRepo: typeof YoutubeVideoGeoStats,
		@Inject('YOUTUBE_GEO_DEVICE_STATS_REPOSITORY')
		private youtubeGeoDeviceStatsRepo: typeof YoutubeGeoDeviceStats,
		@Inject('YOUTUBE_LIVE_VIEWER_STATS_REPOSITORY')
		private youtubeLiveViewerStatsRepo: typeof YoutubeLiveViewerStats,
		@Inject('YOUTUBE_VIDEO_DAILY_STATS_REPOSITORY')
		private youtubeVideoDailyStatsRepo: typeof YoutubeVideoDailyStats,
		@Inject('YOUTUBE_VIDEO_TRAFFIC_SOURCE_STATS_REPOSITORY')
		private youtubeVideoTrafficSourceStatsRepo: typeof YoutubeVideoTrafficSourceStats,
		@Inject('COUNTRY_LIST_REPOSITORY')
		private countryListRepo: typeof CountryList,
		@Inject('YOUTUBE_ANALYTICS_SNAPSHOTS_REPOSITORY')
		private youtubeAnalyticsSnapshotsRepo: typeof YoutubeAnalyticsSnapshots
	) { }

	async onModuleInit() {
		try {
			await this.youtubeChannelRepo.sync();
			await this.youtubeVideoRetentionRepo.sync();
			await this.youtubeVideoGeoStatsRepo.sync();
			await this.youtubeGeoDeviceStatsRepo.sync();
			await this.youtubeLiveViewerStatsRepo.sync();
			await this.youtubeVideoDailyStatsRepo.sync();
			await this.youtubeVideoTrafficSourceStatsRepo.sync();
			await this.countryListRepo.sync();
			await this.youtubeAnalyticsSnapshotsRepo.sync();
		} catch (err) {
			logToErrorFile(err, 'Error while syncing YouTube socialstats tables');
			throw err;
		}
	}

	private logIngestProgress(jobType: string, message: string) {
		this.logger.log(`YouTube ingest [${jobType}] ${message}`);
	}

	async getChannelStats(options?: { bypassCache?: boolean }) {
		const cacheKey = 'youtube:live-channel-stats';
		if (!options?.bypassCache) {
			const cached = this.getFromCache(cacheKey);
			if (cached) return cached;
		}

		try {
			const token = await this.youtubeAuthService.getAccessToken();
			const response = await this.timedGet(
				'youtube.channels.list',
				'https://www.googleapis.com/youtube/v3/channels',
				{
					headers: {
						Authorization: `Bearer ${token.accessToken}`
					},
					params: {
						part: 'snippet,statistics',
						mine: true
					}
				}
			);

			const result = {
				statusCode: HttpStatus.OK,
				message: 'YouTube channel stats fetched successfully',
				data: response.data,
				token: {
					tokenType: token.tokenType,
					expiresInSeconds: token.expiresInSeconds,
					expiresAt: token.expiresAt
				}
			};
			this.setCache(cacheKey, result, 5 * 60_000);
			return result;
		} catch (err) {
			logToErrorFile(err, 'Error while fetching YouTube channel stats');
			throw new BadGatewayException(
				`Unable to fetch YouTube channel stats: ${this.getErrorMessage(err)}`
			);
		}
	}

	/** Lightweight live check: confirms the configured credentials actually authenticate
	 * against the YouTube Data API right now (one minimal channels.list call, 1 quota unit),
	 * without touching the response cache getChannelStats above uses — this exists purely to
	 * answer "do these credentials work". */
	async verifyCredentials() {
		const checkedAt = new Date().toISOString();
		try {
			const token = await this.youtubeAuthService.getAccessToken();
			const response = await this.timedGet(
				'youtube.auth.verify',
				'https://www.googleapis.com/youtube/v3/channels',
				{
					headers: {
						Authorization: `Bearer ${token.accessToken}`
					},
					params: {
						part: 'id,snippet',
						mine: true
					}
				}
			);
			const channel = response.data?.items?.[0];
			return {
				valid: true,
				channelId: channel?.id ?? null,
				channelTitle: channel?.snippet?.title ?? null,
				checkedAt
			};
		} catch (err: any) {
			return { valid: false, reason: this.getErrorMessage(err), checkedAt };
		}
	}

	async getAuthDebugInfo() {
		const auth = await this.youtubeAuthService.getAuthDebugInfo();
		return {
			statusCode: HttpStatus.OK,
			message: 'YouTube auth debug info fetched successfully',
			data: auth
		};
	}

	async ingestChannelStats() {
		this.logIngestProgress('channel_stats', 'started channel stats ingestion');
		const liveResponse = await this.getChannelStats({ bypassCache: true });
		const stats = liveResponse?.data;
		const firstItem = stats?.items?.[0];

		if (!firstItem?.statistics) {
			throw new NotFoundException('No YouTube channel stats available');
		}

		const now = new Date();
		const hourStart = new Date(now);
		hourStart.setMinutes(0, 0, 0);
		const hourEnd = new Date(hourStart);
		hourEnd.setHours(hourEnd.getHours() + 1);

		const existingThisHour = await this.youtubeChannelRepo.findOne({
			where: {
				channelId: firstItem.id,
				fetchedAt: {
					[Op.gte]: hourStart,
					[Op.lt]: hourEnd
				}
			}
		});

		const payload = {
			channelId: firstItem.id,
			channelTitle: firstItem.snippet?.title ?? null,
			subscriberCount: firstItem.statistics.subscriberCount,
			viewCount: firstItem.statistics.viewCount,
			videoCount: firstItem.statistics.videoCount,
			fetchedAt: now
		};
		this.logIngestProgress(
			'channel_stats',
			`fetched live channel stats for channelId=${firstItem.id} title=${firstItem.snippet?.title ?? 'unknown'}`
		);

		let snapshot: YoutubeChannelStats;
		let action: 'created' | 'updated';
		if (existingThisHour) {
			await existingThisHour.update(payload);
			snapshot = existingThisHour;
			action = 'updated';
		} else {
			snapshot = await this.youtubeChannelRepo.create(payload);
			action = 'created';
		}

		this.invalidateCache(['youtube:latest-ingested-stats', 'youtube:live-channel-stats']);
		this.logIngestProgress(
			'channel_stats',
			`${action} hourly snapshot for channelId=${firstItem.id}`
		);

		return {
			statusCode: HttpStatus.OK,
			message: 'YouTube channel stats ingested successfully',
			action,
			data: snapshot,
			token: liveResponse.token
		};
	}

	async getLatestIngestedStats() {
		const cacheKey = 'youtube:latest-ingested-stats';
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const latest = await this.youtubeChannelRepo.findOne({
			order: [['createdAt', 'DESC']],
			raw: true
		});

		if (!latest) {
			throw new NotFoundException('No ingested YouTube stats found');
		}

		const result = {
			statusCode: HttpStatus.OK,
			message: 'Latest ingested YouTube stats fetched successfully',
			data: latest
		};
		this.setCache(cacheKey, result, 60_000);
		return result;
	}

	async getCurrentLiveStreamStats(options?: { bypassCache?: boolean }) {
		const cacheKey = 'youtube:current-live-stream-stats';
		if (!options?.bypassCache) {
			const cached = this.getFromCache(cacheKey);
			if (cached) return cached;
		}

		try {
			const token = await this.youtubeAuthService.getAccessToken();
			const broadcastResponse = await this.timedGet(
				'youtube.liveBroadcasts.list.active',
				'https://www.googleapis.com/youtube/v3/liveBroadcasts',
				{
					headers: {
						Authorization: `Bearer ${token.accessToken}`
					},
					params: {
						part: 'id,snippet,contentDetails,status',
						mine: true,
						maxResults: 25
					}
				}
			);

			const broadcasts = Array.isArray(broadcastResponse.data?.items)
				? broadcastResponse.data.items
				: [];
			const broadcast =
				broadcasts.find((item: any) => String(item?.status?.lifeCycleStatus || '').toLowerCase() === 'live') ||
				broadcasts.find((item: any) => String(item?.status?.lifeCycleStatus || '').toLowerCase() === 'livestarting') ||
				null;
			if (!broadcast?.id) {
				const result = {
					statusCode: HttpStatus.OK,
					message: 'No active YouTube live stream found',
					data: null,
					token: {
						tokenType: token.tokenType,
						expiresInSeconds: token.expiresInSeconds,
						expiresAt: token.expiresAt
					}
				};
				this.setCache(cacheKey, result, 30_000);
				return result;
			}

			const videoResponse = await this.timedGet(
				'youtube.videos.list.live-streaming-details',
				'https://www.googleapis.com/youtube/v3/videos',
				{
					headers: {
						Authorization: `Bearer ${token.accessToken}`
					},
					params: {
						part: 'snippet,statistics,contentDetails,liveStreamingDetails,status',
						id: broadcast.id,
						maxResults: 1
					}
				}
			);

			const video = videoResponse.data?.items?.[0] || null;
			const liveStreamingDetails = video?.liveStreamingDetails || {};
			const statistics = video?.statistics || {};
			const snippet = video?.snippet || {};

			const result = {
				statusCode: HttpStatus.OK,
				message: 'YouTube current live stream stats fetched successfully',
				data: video ? {
					videoId: video.id,
					title: snippet?.title || '',
					description: snippet?.description || '',
					channelId: snippet?.channelId || null,
					channelTitle: snippet?.channelTitle || '',
					publishedAt: snippet?.publishedAt || null,
					liveBroadcastContent: snippet?.liveBroadcastContent || null,
					thumbnail:
						snippet?.thumbnails?.maxres?.url ||
						snippet?.thumbnails?.standard?.url ||
						snippet?.thumbnails?.high?.url ||
						snippet?.thumbnails?.medium?.url ||
						snippet?.thumbnails?.default?.url ||
						null,
					concurrentViewers: Number(liveStreamingDetails?.concurrentViewers ?? 0),
					actualStartTime: liveStreamingDetails?.actualStartTime || null,
					actualEndTime: liveStreamingDetails?.actualEndTime || null,
					scheduledStartTime: liveStreamingDetails?.scheduledStartTime || null,
					scheduledEndTime: liveStreamingDetails?.scheduledEndTime || null,
					activeLiveChatId: liveStreamingDetails?.activeLiveChatId || null,
					lifeTimeViews: Number(statistics?.viewCount ?? 0),
					likes: Number(statistics?.likeCount ?? 0),
					comments: Number(statistics?.commentCount ?? 0),
					duration: video?.contentDetails?.duration || null,
					privacyStatus: video?.status?.privacyStatus || null,
					embeddable: Boolean(video?.status?.embeddable ?? false),
					broadcastStatus: broadcast?.status?.lifeCycleStatus || null,
					broadcast: {
						id: broadcast.id,
						snippet: broadcast?.snippet || {},
						contentDetails: broadcast?.contentDetails || {},
						status: broadcast?.status || {}
					}
				} : null,
				token: {
					tokenType: token.tokenType,
					expiresInSeconds: token.expiresInSeconds,
					expiresAt: token.expiresAt
				}
			};

			this.setCache(cacheKey, result, 30_000);
			return result;
		} catch (err) {
			logToErrorFile(err, 'Error while fetching YouTube current live stream stats');
			throw new BadGatewayException(
				`Unable to fetch YouTube current live stream stats: ${this.getErrorMessage(err)}`
			);
		}
	}

	async getLiveDashboard(startDate?: string, endDate?: string) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const cacheKey = `youtube:live-dashboard:${range.startDate}:${range.endDate}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		try {
			const token = await this.youtubeAuthService.getAccessToken();
			const [channelStatsResponse, currentLiveResponse, broadcasts] = await Promise.all([
				this.getChannelStats(),
				this.getCurrentLiveStreamStats(),
				this.fetchOwnLiveBroadcasts(token.accessToken)
			]);

			const relevantBroadcasts = this.filterBroadcastsForRange(broadcasts, range);
			const videoIds = relevantBroadcasts.map((item: any) => String(item?.id || '')).filter(Boolean);
			const videoDetailsMap = await this.fetchVideosMap(
				token.accessToken,
				videoIds,
				'snippet,statistics,contentDetails,liveStreamingDetails,status'
			);
			const dayRows = await this.fetchLiveAnalyticsByDay(
				token.accessToken,
				videoIds,
				range.startDate,
				range.endDate
			);
			const countryRows = await this.fetchLiveAnalyticsByCountry(
				token.accessToken,
				videoIds,
				range.startDate,
				range.endDate
			);
			const liveVideoRows = relevantBroadcasts.map((broadcast: any) =>
				this.buildLiveBroadcastRow(broadcast, videoDetailsMap[String(broadcast?.id || '')] || null)
			);
			const locationMap = await this.getCountryLocationMap(
				countryRows.map((row: any) => String(row.countryCode || ''))
			);
			const totalCountryViews = countryRows.reduce(
				(sum: number, row: any) => sum + Number(row?.views || 0),
				0
			);
			const totalCountryWatchMinutes = countryRows.reduce(
				(sum: number, row: any) => sum + Number(row?.estimatedMinutesWatched || 0),
				0
			);
			const countries = countryRows
				.map((row: any) => {
					const countryCode = this.normalizeCountryCode(row.countryCode);
					const location = countryCode ? locationMap.get(countryCode) : null;
					return {
						...row,
						countryCode,
						slug: location?.slug ?? null,
						geoName: location?.name ?? null,
						lat: location?.latitude ?? null,
						lng: location?.longitude ?? null,
						watchTimeHours: Number(row.estimatedMinutesWatched || 0) / 60,
						viewsSharePercent: totalCountryViews
							? Number((((Number(row.views || 0) / totalCountryViews) * 100)).toFixed(2))
							: 0,
						watchTimeSharePercent: totalCountryWatchMinutes
							? Number((((Number(row.estimatedMinutesWatched || 0) / totalCountryWatchMinutes) * 100)).toFixed(2))
							: 0
					};
				})
				.sort((a: any, b: any) => Number(b.views || 0) - Number(a.views || 0));

			const totals = dayRows.reduce(
				(acc: any, row: any) => {
					acc.views += Number(row.views || 0);
					acc.estimatedMinutesWatched += Number(row.estimatedMinutesWatched || 0);
					acc.subscribersGained += Number(row.subscribersGained || 0);
					acc.subscribersLost += Number(row.subscribersLost || 0);
					return acc;
				},
				{
					views: 0,
					estimatedMinutesWatched: 0,
					subscribersGained: 0,
					subscribersLost: 0
				}
			);
			const totalWeightedDuration = dayRows.reduce(
				(sum: number, row: any) =>
					sum + (Number(row.views || 0) * Number(row.averageViewDurationSeconds || 0)),
				0
			);
			const liveStatusCounts = liveVideoRows.reduce(
				(acc: any, row: any) => {
					const statusKey = String(row?.broadcastStatus || 'unknown').toLowerCase();
					acc[statusKey] = Number(acc[statusKey] || 0) + 1;
					return acc;
				},
				{}
			);

			const result = {
				statusCode: HttpStatus.OK,
				message: 'YouTube live dashboard fetched successfully',
				range,
				generatedAt: new Date().toISOString(),
				data: {
					channel: channelStatsResponse?.data?.items?.[0] || null,
					currentLive: currentLiveResponse?.data || null,
					summary: {
						totalLiveBroadcasts: liveVideoRows.length,
						currentlyLiveCount: liveVideoRows.filter(
							(row: any) => String(row?.broadcastStatus || '').toLowerCase() === 'live'
						).length,
						totalViews: totals.views,
						totalWatchTimeHours: totals.estimatedMinutesWatched / 60,
						totalSubscribersGained: totals.subscribersGained,
						totalSubscribersLost: totals.subscribersLost,
						netSubscribers: totals.subscribersGained - totals.subscribersLost,
						averageViewDurationSeconds: totals.views
							? Number((totalWeightedDuration / totals.views).toFixed(2))
							: 0,
						currentConcurrentViewers: Number(currentLiveResponse?.data?.concurrentViewers || 0),
						uniqueCountries: countries.length,
						statusCounts: liveStatusCounts
					},
					trend: dayRows,
					countries,
					liveVideos: liveVideoRows
				}
			};

			this.setCache(cacheKey, result, 5 * 60_000);
			return result;
		} catch (err) {
			logToErrorFile(err, 'Error while fetching YouTube live dashboard');
			throw new BadGatewayException(
				`Unable to fetch YouTube live dashboard: ${this.getErrorMessage(err)}${this.getAnalyticsScopeHint(
					err
				)}${this.getAnalyticsAccessHint(err)}`
			);
		}
	}

	async ingestCurrentLiveViewerSnapshot() {
		this.logIngestProgress('live_viewers', 'started live viewer snapshot ingestion');
		const currentLiveResponse = await this.getCurrentLiveStreamStats({ bypassCache: true });
		const currentLive = currentLiveResponse?.data;
		if (!currentLive?.videoId || !currentLive?.channelId) {
			this.logIngestProgress('live_viewers', 'no active live stream found, skipping snapshot');
			return {
				statusCode: HttpStatus.OK,
				message: 'No active YouTube live stream found for viewer snapshot ingestion',
				data: {
					ingested: false
				}
			};
		}

		const now = new Date();
		const existingRecent = await this.youtubeLiveViewerStatsRepo.findOne({
			where: {
				channelId: currentLive.channelId,
				videoId: currentLive.videoId,
				sampledAt: {
					[Op.gte]: new Date(now.getTime() - 90_000)
				}
			},
			order: [['sampledAt', 'DESC']]
		});
		const payload = this.buildLiveViewerSamplePayload(currentLive, now);
		this.logIngestProgress(
			'live_viewers',
			`resolved active live stream videoId=${currentLive.videoId} channelId=${currentLive.channelId} concurrentViewers=${Number(payload.concurrentViewers || 0)}`
		);

		if (existingRecent) {
			await existingRecent.update(payload);
			this.invalidateCache([`youtube:live-viewers:${currentLive.channelId}:${currentLive.videoId}`]);
			this.logIngestProgress(
				'live_viewers',
				`updated recent live viewer snapshot for videoId=${currentLive.videoId}`
			);
			return {
				statusCode: HttpStatus.OK,
				message: 'YouTube live viewer snapshot updated successfully',
				data: {
					ingested: true,
					mode: 'updated',
					videoId: currentLive.videoId,
					channelId: currentLive.channelId,
					sampledAt: payload.sampledAt,
					concurrentViewers: Number(payload.concurrentViewers || 0)
				}
			};
		}

		await this.youtubeLiveViewerStatsRepo.create(payload);
		this.invalidateCache([`youtube:live-viewers:${currentLive.channelId}:${currentLive.videoId}`]);
		this.logIngestProgress(
			'live_viewers',
			`created new live viewer snapshot for videoId=${currentLive.videoId}`
		);
		return {
			statusCode: HttpStatus.OK,
			message: 'YouTube live viewer snapshot ingested successfully',
			data: {
				ingested: true,
				mode: 'created',
				videoId: currentLive.videoId,
				channelId: currentLive.channelId,
				sampledAt: payload.sampledAt,
				concurrentViewers: Number(payload.concurrentViewers || 0)
			}
		};
	}

	async getLiveViewerTimeline(
		channelId: string,
		videoId: string,
		startDate?: string,
		endDate?: string
	) {
		const hasExplicitRange = !!(startDate || endDate);
		if (hasExplicitRange && (!startDate || !endDate)) {
			throw new BadRequestException(
				'Both startDate and endDate are required when filtering live viewer timeline'
			);
		}

		if (startDate) {
			this.parseDateOnlyString(startDate, 'startDate');
		}
		if (endDate) {
			this.parseDateOnlyString(endDate, 'endDate');
		}

		if (!hasExplicitRange) {
			const defaultRange = this.resolveDateRange(startDate, endDate, 7);
			startDate = defaultRange.startDate;
			endDate = defaultRange.endDate;
		}

		const cacheKey = `youtube:live-viewers:${channelId}:${videoId}:${startDate || 'all'}:${endDate || 'all'}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const where: any = {
			channelId,
			videoId
		};
		if (startDate && endDate) {
			where.sampledAt = {
				[Op.between]: [
					new Date(`${startDate}T00:00:00.000Z`),
					new Date(`${endDate}T23:59:59.999Z`)
				]
			};
		}

		const rows = await this.youtubeLiveViewerStatsRepo.findAll({
			where,
			order: [['sampledAt', 'ASC']],
			raw: true
		});
		const points: any[] = rows.map((row: any) =>
			this.normalizeLiveViewerTimelinePoint(row)
		);

		try {
			const currentLiveResponse = await this.withTimeout(
				this.getCurrentLiveStreamStats(),
				3_000,
				'getCurrentLiveStreamStats'
			);
			const currentLive = currentLiveResponse?.data;
			if (currentLive?.videoId === videoId && currentLive?.channelId === channelId) {
				const lastPoint = points[points.length - 1] || null;
				const currentPoint = this.normalizeLiveViewerTimelinePoint({
					...this.buildLiveViewerSamplePayload(currentLive, new Date()),
					id: null
				});
				const shouldAppendCurrentPoint =
					!lastPoint
					|| Math.abs(
						new Date(currentPoint.sampledAt).getTime()
						- new Date(lastPoint.sampledAt).getTime()
					) > 90_000;

				if (shouldAppendCurrentPoint) {
					points.push({
						...currentPoint,
						isTransient: true
					});
				}
			}
		} catch (err) {
			this.logger.warn(
				`Unable to append latest live viewer snapshot for ${videoId}: ${this.getErrorMessage(err)}`
			);
		}

		const summary = this.buildLiveViewerTimelineSummary(points);
		const result = {
			statusCode: HttpStatus.OK,
			message: points.length
				? 'YouTube live viewer timeline fetched successfully'
				: 'No live viewer samples captured for this video yet',
			data: {
				channelId,
				videoId,
				startDate: startDate || null,
				endDate: endDate || null,
				points,
				summary,
				availabilityStatus: points.length ? 'available' : 'not_captured_yet',
				availabilityMessage: points.length
					? ''
					: 'No live viewer snapshots have been captured for this video yet. Samples are recorded only while the stream is live.'
			}
		};
		this.setCache(cacheKey, result, points.length ? 60_000 : 30_000);
		return result;
	}

	async getAnalyticsTimeseries(
		startDate?: string,
		endDate?: string,
		page?: number,
		limit?: number
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const cacheKey = `youtube:analytics:timeseries:${range.startDate}:${range.endDate}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return this.applyPaginationToRowsResponse(cached, page, limit, 30, 365);

		try {
			const token = await this.youtubeAuthService.getAccessToken();
			const response = await this.timedGet(
				'youtubeanalytics.reports.timeseries',
				'https://youtubeanalytics.googleapis.com/v2/reports',
				{
					headers: {
						Authorization: `Bearer ${token.accessToken}`
					},
					params: {
						ids: 'channel==MINE',
						startDate: range.startDate,
						endDate: range.endDate,
						dimensions: 'day',
						// New metrics are appended, never inserted: the admin UI reads these rows by
						// column position (day=0 … subscribersLost=5).
						metrics:
							'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,shares,dislikes,averageViewPercentage,engagedViews,videosAddedToPlaylists',
						sort: 'day'
					}
				}
			);

			const result = {
				statusCode: HttpStatus.OK,
				message: 'YouTube analytics timeseries fetched successfully',
				data: response.data,
				range,
				token: {
					tokenType: token.tokenType,
					expiresInSeconds: token.expiresInSeconds,
					expiresAt: token.expiresAt
				}
			};
			this.setCache(cacheKey, result, 10 * 60_000);
			await this.persistAnalyticsSnapshot('timeseries', range, response.data);
			await this.dataCoverageService.recordAttempt({
				platform: 'youtube',
				jobType: 'analytics_snapshot',
				metricKey: 'youtube.analytics.timeseries',
				success: true
			});
			return this.applyPaginationToRowsResponse(result, page, limit, 30, 365);
		} catch (err) {
			logToErrorFile(err, 'Error while fetching YouTube analytics timeseries');
			await this.recordAnalyticsCoverageFailure('analytics_snapshot', 'youtube.analytics.timeseries', err);
			throw new BadGatewayException(
				`Unable to fetch YouTube analytics timeseries: ${this.getErrorMessage(err)}${this.getAnalyticsScopeHint(
					err
				)}`
			);
		}
	}

	async getTrafficSources(
		startDate?: string,
		endDate?: string,
		page?: number,
		limit?: number
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const cacheKey = `youtube:traffic-sources:${range.startDate}:${range.endDate}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return this.applyPaginationToRowsResponse(cached, page, limit, 25, 100);

		try {
			const token = await this.youtubeAuthService.getAccessToken();
			const response = await this.timedGet(
				'youtubeanalytics.reports.traffic-sources',
				'https://youtubeanalytics.googleapis.com/v2/reports',
				{
					headers: {
						Authorization: `Bearer ${token.accessToken}`
					},
					params: {
						ids: 'channel==MINE',
						startDate: range.startDate,
						endDate: range.endDate,
						dimensions: 'insightTrafficSourceType',
						metrics: 'views,estimatedMinutesWatched',
						sort: '-views',
						maxResults: 25
					}
				}
			);

			const result = {
				statusCode: HttpStatus.OK,
				message: 'YouTube traffic sources fetched successfully',
				data: response.data,
				range,
				token: {
					tokenType: token.tokenType,
					expiresInSeconds: token.expiresInSeconds,
					expiresAt: token.expiresAt
				}
			};
			this.setCache(cacheKey, result, 10 * 60_000);
			await this.persistAnalyticsSnapshot('traffic_sources', range, response.data);
			await this.dataCoverageService.recordAttempt({
				platform: 'youtube',
				jobType: 'traffic_sources',
				metricKey: 'youtube.analytics.traffic_source_type',
				success: true
			});
			return this.applyPaginationToRowsResponse(result, page, limit, 25, 100);
		} catch (err) {
			logToErrorFile(err, 'Error while fetching YouTube traffic sources');
			await this.recordAnalyticsCoverageFailure(
				'traffic_sources',
				'youtube.analytics.traffic_source_type',
				err
			);
			throw new BadGatewayException(
				`Unable to fetch YouTube traffic sources: ${this.getErrorMessage(err)}${this.getAnalyticsScopeHint(
					err
				)}`
			);
		}
	}

	/**
	 * Shared shape for the simple "one Analytics query, return its rows" reports below:
	 * cache, quota-tracked call, snapshot archive, coverage bookkeeping, error hint.
	 */
	private async fetchSimpleAnalyticsReport(options: {
		reportKey: string;
		endpointLabel: string;
		metricKey: string;
		message: string;
		range: { startDate: string; endDate: string };
		params: Record<string, unknown>;
		cacheKey: string;
	}) {
		const cached = this.getFromCache(options.cacheKey);
		if (cached) return cached;

		try {
			const token = await this.youtubeAuthService.getAccessToken();
			const response = await this.timedGet(
				options.endpointLabel,
				'https://youtubeanalytics.googleapis.com/v2/reports',
				{
					headers: { Authorization: `Bearer ${token.accessToken}` },
					params: {
						ids: 'channel==MINE',
						startDate: options.range.startDate,
						endDate: options.range.endDate,
						...options.params
					}
				}
			);

			const result = {
				statusCode: HttpStatus.OK,
				message: options.message,
				data: response.data,
				range: options.range,
				token: {
					tokenType: token.tokenType,
					expiresInSeconds: token.expiresInSeconds,
					expiresAt: token.expiresAt
				}
			};
			this.setCache(options.cacheKey, result, 10 * 60_000);
			await this.persistAnalyticsSnapshot(options.reportKey, options.range, response.data);
			await this.dataCoverageService.recordAttempt({
				platform: 'youtube',
				jobType: options.reportKey,
				metricKey: options.metricKey,
				success: true
			});
			return result;
		} catch (err) {
			logToErrorFile(err, `Error while fetching YouTube ${options.reportKey}`);
			await this.recordAnalyticsCoverageFailure(options.reportKey, options.metricKey, err);
			throw new BadGatewayException(
				`Unable to fetch YouTube ${options.reportKey.replace(/_/g, ' ')}: ${this.getErrorMessage(err)}${this.getAnalyticsScopeHint(err)}`
			);
		}
	}

	/** Shorts vs long-form vs live vs posts. Views alone hide that the live stream is where
	 * the watch time is (Sept 2026: 7% of views, 63% of minutes). */
	async getContentTypeBreakdown(startDate?: string, endDate?: string) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		return await this.fetchSimpleAnalyticsReport({
			reportKey: 'content_type',
			endpointLabel: 'youtubeanalytics.reports.content-type',
			metricKey: 'youtube.analytics.content_type',
			message: 'YouTube content-type breakdown fetched successfully',
			range,
			cacheKey: `youtube:content-type:${range.startDate}:${range.endDate}`,
			params: {
				dimensions: 'creatorContentType',
				metrics: 'views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained',
				sort: '-views'
			}
		});
	}

	/** Live vs on-demand split of views and watch time. (Concurrent-viewer metrics are not
	 * supported by the Analytics API for this channel; the 2-minute sampler covers those.) */
	async getLiveVsOnDemand(startDate?: string, endDate?: string) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		return await this.fetchSimpleAnalyticsReport({
			reportKey: 'live_vs_on_demand',
			endpointLabel: 'youtubeanalytics.reports.live-vs-on-demand',
			metricKey: 'youtube.analytics.live_vs_on_demand',
			message: 'YouTube live vs on-demand breakdown fetched successfully',
			range,
			cacheKey: `youtube:live-vs-on-demand:${range.startDate}:${range.endDate}`,
			params: {
				dimensions: 'liveOrOnDemand',
				metrics: 'views,estimatedMinutesWatched,averageViewDuration',
				sort: '-views'
			}
		});
	}

	/** Who is watching and where: subscribed vs not, Shorts feed / watch page / browse,
	 * core YouTube vs Music. Three reports, one response. */
	async getViewerSegments(startDate?: string, endDate?: string) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const cacheKey = `youtube:viewer-segments:${range.startDate}:${range.endDate}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const segments = [
			{ key: 'subscribedStatus', dimensions: 'subscribedStatus' },
			{ key: 'playbackLocation', dimensions: 'insightPlaybackLocationType' },
			{ key: 'youtubeProduct', dimensions: 'youtubeProduct' }
		];
		const data: Record<string, unknown> = {};
		const failed: Array<{ segment: string; reason: string }> = [];
		for (const segment of segments) {
			try {
				const report = await this.fetchSimpleAnalyticsReport({
					reportKey: `viewer_segments_${segment.key}`,
					endpointLabel: `youtubeanalytics.reports.viewer-segments.${segment.key}`,
					metricKey: `youtube.analytics.viewer_segments.${segment.key}`,
					message: 'ok',
					range,
					cacheKey: `${cacheKey}:${segment.key}`,
					params: {
						dimensions: segment.dimensions,
						metrics: 'views,estimatedMinutesWatched',
						sort: '-views'
					}
				});
				data[segment.key] = report.data;
			} catch (err) {
				failed.push({ segment: segment.key, reason: this.getErrorMessage(err) });
			}
		}
		if (failed.length === segments.length) {
			throw new BadGatewayException(
				`Unable to fetch YouTube viewer segments: ${failed.map((f) => `${f.segment}: ${f.reason}`).join(' | ')}`
			);
		}

		const result = {
			statusCode: HttpStatus.OK,
			message: 'YouTube viewer segments fetched successfully',
			range,
			data,
			failed
		};
		this.setCache(cacheKey, result, 10 * 60_000);
		return result;
	}

	/** Daily estimated revenue and ad metrics. Needs the yt-analytics-monetary.readonly
	 * scope on the refresh token (present) and a monetized channel (it is). */
	async getMonetization(startDate?: string, endDate?: string) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const report = await this.fetchSimpleAnalyticsReport({
			reportKey: 'monetization',
			endpointLabel: 'youtubeanalytics.reports.monetization',
			metricKey: 'youtube.analytics.monetization',
			message: 'YouTube monetization fetched successfully',
			range,
			cacheKey: `youtube:monetization:${range.startDate}:${range.endDate}`,
			params: {
				dimensions: 'day',
				metrics: 'estimatedRevenue,estimatedAdRevenue,monetizedPlaybacks,adImpressions,cpm,playbackBasedCpm',
				sort: 'day'
			}
		});

		const rows: any[][] = report?.data?.rows || [];
		const totals = rows.reduce(
			(acc, row) => {
				acc.estimatedRevenue += Number(row[1] || 0);
				acc.estimatedAdRevenue += Number(row[2] || 0);
				acc.monetizedPlaybacks += Number(row[3] || 0);
				acc.adImpressions += Number(row[4] || 0);
				return acc;
			},
			{ estimatedRevenue: 0, estimatedAdRevenue: 0, monetizedPlaybacks: 0, adImpressions: 0 }
		);
		return {
			...report,
			totals: {
				...totals,
				// Blended CPM over the range, not an average of daily CPMs.
				cpm: totals.adImpressions
					? Number(((totals.estimatedAdRevenue / totals.adImpressions) * 1000).toFixed(3))
					: 0,
				currency: 'USD'
			}
		};
	}

	/** Records why a live YouTube Analytics report call failed, distinguishing an actual
	 * permission problem from the API simply withholding data below its privacy threshold
	 * (which comes back as an empty/quiet response, not an error, and is handled by the
	 * caller before this is invoked). */
	private async recordAnalyticsCoverageFailure(jobType: string, metricKey: string, err: any) {
		const reason = this.getErrorMessage(err);
		const status = this.youtubeQuotaService.isQuotaExceededError(err)
			? 'unavailable_quota'
			: err?.response?.status === 403
				? 'unavailable_permission'
				: 'unavailable_error';
		await this.dataCoverageService.recordAttempt({
			platform: 'youtube',
			jobType,
			metricKey,
			success: false,
			status,
			reason
		});
	}

	/**
	 * insightTrafficSourceType can no longer be combined with insightTrafficSourceDetail
	 * as a second dimension (YouTube Analytics API now requires it as a single-value
	 * filter instead — "The query is not supported" otherwise). CAMPAIGN_CARD, END_SCREEN,
	 * NOTIFICATION, NO_LINK_EMBEDDED and VIDEO_REMIXES are excluded because Google's docs
	 * mark them unsupported for the traffic-source-detail report specifically.
	 */
	private readonly trafficSourceDetailTypes = [
		'ADVERTISING', 'ANNOTATION', 'EXT_URL', 'HASHTAGS', 'LIVE_REDIRECT', 'NO_LINK_OTHER',
		'PLAYLIST', 'PRODUCT_PAGE', 'PROMOTED', 'RELATED_VIDEO', 'SHORTS', 'SOUND_PAGE',
		'SUBSCRIBER', 'YT_CHANNEL', 'YT_OTHER_PAGE', 'YT_SEARCH', 'WATCH_WITH'
	];

	async getTrafficSourceDetail(
		startDate?: string,
		endDate?: string,
		page?: number,
		limit?: number
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const cacheKey = `youtube:traffic-source-detail:${range.startDate}:${range.endDate}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return this.applyPaginationToRowsResponse(cached, page, limit, 25, 100);

		try {
			const token = await this.youtubeAuthService.getAccessToken();
			const combinedRows: any[][] = [];
			let columnHeaders: any[] = [];
			let lastError: any = null;
			let failureCount = 0;

			for (const sourceType of this.trafficSourceDetailTypes) {
				try {
					const response = await this.timedGet(
						`youtubeanalytics.reports.traffic-source-detail.${sourceType}`,
						'https://youtubeanalytics.googleapis.com/v2/reports',
						{
							headers: {
								Authorization: `Bearer ${token.accessToken}`
							},
							params: {
								ids: 'channel==MINE',
								startDate: range.startDate,
								endDate: range.endDate,
								dimensions: 'insightTrafficSourceDetail',
								metrics: 'views,estimatedMinutesWatched',
								filters: `insightTrafficSourceType==${sourceType}`,
								sort: '-views',
								maxResults: 25
							}
						}
					);

					if (!columnHeaders.length && response.data?.columnHeaders?.length) {
						columnHeaders = [{ name: 'insightTrafficSourceType' }, ...response.data.columnHeaders];
					}
					for (const row of response.data?.rows || []) {
						combinedRows.push([sourceType, ...row]);
					}
				} catch (typeErr) {
					lastError = typeErr;
					failureCount++;
					this.logger.warn(
						`youtubeanalytics.reports.traffic-source-detail.${sourceType} failed: ${this.getErrorMessage(typeErr)}`
					);
				}
			}

			if (failureCount === this.trafficSourceDetailTypes.length && lastError) {
				throw lastError;
			}

			combinedRows.sort((a, b) => Number(b[2] || 0) - Number(a[2] || 0));
			const data = {
				columnHeaders,
				rows: combinedRows.slice(0, 100)
			};

			const result = {
				statusCode: HttpStatus.OK,
				message: 'YouTube traffic source detail fetched successfully',
				data,
				range,
				token: {
					tokenType: token.tokenType,
					expiresInSeconds: token.expiresInSeconds,
					expiresAt: token.expiresAt
				}
			};
			this.setCache(cacheKey, result, 10 * 60_000);
			await this.persistAnalyticsSnapshot('traffic_source_detail', range, data);
			const hasRows = Boolean(data.rows.length);
			await this.dataCoverageService.recordAttempt({
				platform: 'youtube',
				jobType: 'traffic_sources',
				metricKey: 'youtube.analytics.traffic_source_detail',
				success: hasRows,
				status: hasRows ? undefined : 'unavailable_insufficient_data',
				reason: hasRows
					? undefined
					: 'YouTube returned no rows for insightTrafficSourceDetail (often below the reporting threshold for low-traffic sources)'
			});
			return this.applyPaginationToRowsResponse(result, page, limit, 25, 100);
		} catch (err) {
			logToErrorFile(err, 'Error while fetching YouTube traffic source detail');
			await this.recordAnalyticsCoverageFailure(
				'traffic_sources',
				'youtube.analytics.traffic_source_detail',
				err
			);
			throw new BadGatewayException(
				`Unable to fetch YouTube traffic source detail: ${this.getErrorMessage(err)}${this.getAnalyticsScopeHint(
					err
				)}`
			);
		}
	}

	async getAudienceDemographics(startDate?: string, endDate?: string) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const cacheKey = `youtube:audience-demographics:${range.startDate}:${range.endDate}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const reportConfigs = [
			{ key: 'ageGender', dimensions: 'ageGroup,gender', metrics: 'viewerPercentage' },
			{ key: 'geography', dimensions: 'country', metrics: 'viewerPercentage', sort: '-viewerPercentage' }
		];

		try {
			const token = await this.youtubeAuthService.getAccessToken();
			const reports: Record<string, any> = {};

			for (const config of reportConfigs) {
				const metricKey = `youtube.analytics.audience_demographics.${config.key}`;
				try {
					const response = await this.timedGet(
						`youtubeanalytics.reports.demographics.${config.key}`,
						'https://youtubeanalytics.googleapis.com/v2/reports',
						{
							headers: {
								Authorization: `Bearer ${token.accessToken}`
							},
							params: {
								ids: 'channel==MINE',
								startDate: range.startDate,
								endDate: range.endDate,
								dimensions: config.dimensions,
								metrics: config.metrics,
								...(config.sort ? { sort: config.sort } : {}),
								maxResults: 25
							}
						}
					);

					const hasRows = Boolean((response.data?.rows || []).length);
					reports[config.key] = response.data;
					await this.dataCoverageService.recordAttempt({
						platform: 'youtube',
						jobType: 'audience_demographics',
						metricKey,
						success: hasRows,
						status: hasRows ? undefined : 'unavailable_insufficient_data',
						reason: hasRows
							? undefined
							: 'YouTube returned no rows for this demographic breakdown (often below the reporting threshold for low-traffic channels)'
					});
				} catch (err) {
					reports[config.key] = null;
					await this.recordAnalyticsCoverageFailure('audience_demographics', metricKey, err);
				}
			}

			const result = {
				statusCode: HttpStatus.OK,
				message: 'YouTube audience demographics fetched successfully',
				data: reports,
				range
			};
			this.setCache(cacheKey, result, 10 * 60_000);
			await this.persistAnalyticsSnapshot('audience_demographics', range, reports);
			return result;
		} catch (err) {
			logToErrorFile(err, 'Error while fetching YouTube audience demographics');
			await this.recordAnalyticsCoverageFailure(
				'audience_demographics',
				'youtube.analytics.audience_demographics',
				err
			);
			throw new BadGatewayException(
				`Unable to fetch YouTube audience demographics: ${this.getErrorMessage(err)}${this.getAnalyticsScopeHint(
					err
				)}`
			);
		}
	}

	async getImpressionsAndCtr(
		startDate?: string,
		endDate?: string,
		maxResults?: number,
		page?: number,
		limit?: number
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const safeMaxResults =
			Number.isFinite(maxResults) && Number(maxResults) > 0 ? Math.min(Number(maxResults), 50) : 25;
		const cacheKey = `youtube:impressions-ctr:${range.startDate}:${range.endDate}:${safeMaxResults}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return this.applyPaginationToRowsResponse(cached, page, limit, 10, 50);

		const metricKey = 'youtube.analytics.impressions_ctr';
		try {
			// videoThumbnailImpressions/videoThumbnailImpressionsClickRate are only available via
			// the YouTube Reporting API's async "reach" report job, not the interactive Analytics
			// API this module otherwise uses live. YoutubeReachService keeps a local copy of that
			// report (synced daily by YoutubeIngestService), so this reads from our own DB instead.
			const aggregatedRows = await this.youtubeReachService.getAggregatedImpressions(
				range.startDate,
				range.endDate,
				safeMaxResults
			);

			const videoIds = aggregatedRows.map((row) => row.videoId).filter(Boolean);
			const videoDetailsMap = videoIds.length
				? await this.fetchVideosMap((await this.youtubeAuthService.getAccessToken()).accessToken, videoIds)
				: {};

			const enrichedRows = aggregatedRows.map((row) => ({
				videoId: row.videoId,
				impressions: row.impressions,
				impressionClickThroughRate: row.impressionClickThroughRate,
				video: videoDetailsMap[row.videoId] || null
			}));

			const result = {
				statusCode: HttpStatus.OK,
				message: 'YouTube impressions and click-through rate fetched successfully',
				data: {
					columnHeaders: [
						{ name: 'video' },
						{ name: 'videoThumbnailImpressions' },
						{ name: 'videoThumbnailImpressionsClickRate' }
					],
					rows: enrichedRows
				},
				range,
				maxResults: safeMaxResults
			};
			this.setCache(cacheKey, result, 10 * 60_000);
			await this.persistAnalyticsSnapshot('impressions_ctr', range, result.data);
			await this.dataCoverageService.recordAttempt({
				platform: 'youtube',
				jobType: 'impressions_ctr',
				metricKey,
				success: Boolean(enrichedRows.length),
				status: enrichedRows.length ? undefined : 'unavailable_insufficient_data',
				reason: enrichedRows.length
					? undefined
					: 'No YouTube reach report data ingested yet for this range (reach reports have up to ~48h latency from Google and are synced once daily)'
			});
			return this.applyPaginationToRowsResponse(result, page, limit, 10, 50);
		} catch (err) {
			logToErrorFile(err, 'Error while fetching YouTube impressions and CTR');
			await this.recordAnalyticsCoverageFailure('impressions_ctr', metricKey, err);
			throw new BadGatewayException(
				`Unable to fetch YouTube impressions/CTR: ${this.getErrorMessage(err)}${this.getAnalyticsScopeHint(
					err
				)}${this.getAnalyticsAccessHint(err)}`
			);
		}
	}

	async getBulkVideoDailyStats(
		startDate?: string,
		endDate?: string,
		maxResults?: number,
		page?: number,
		limit?: number
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const safeMaxResults = this.resolveTopN(maxResults, 10, 100);
		const cacheKey = `youtube:bulk-video-daily:${range.startDate}:${range.endDate}:${safeMaxResults}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return this.applyPaginationToRowsResponse(cached, page, limit, 10, 100);

		const rows = await this.youtubeVideoDailyStatsRepo.findAll({
			where: {
				statDate: {
					[Op.between]: [range.startDate, range.endDate]
				}
			},
			order: [
				['statDate', 'ASC'],
				['views', 'DESC']
			],
			raw: true
		});

		const byVideo = new Map<
			string,
			{
				videoId: string;
				channelId: string | null;
				views: number;
				liveViews: number;
				subscribedViews: number;
				redViews: number;
				watchTimeMinutes: number;
				averageViewDurationSecondsWeighted: number;
				averageViewDurationPercentageWeighted: number;
				likes: number;
				dislikes: number;
				comments: number;
				shares: number;
				subscribersGained: number;
				subscribersLost: number;
				videosAddedToPlaylists: number;
				videosRemovedFromPlaylists: number;
				daysTracked: number;
			}
		>();

		let totalViews = 0;
		let totalWatchTimeMinutes = 0;

		for (const row of rows as Array<any>) {
			const videoId = String(row?.videoId || '');
			if (!videoId) {
				continue;
			}

			const views = Number(row?.views || 0);
			const watchTimeMinutes = Number(row?.watchTimeMinutes || 0);
			totalViews += views;
			totalWatchTimeMinutes += watchTimeMinutes;

			const entry = byVideo.get(videoId) || {
				videoId,
				channelId: row?.channelId ? String(row.channelId) : null,
				views: 0,
				liveViews: 0,
				subscribedViews: 0,
				redViews: 0,
				watchTimeMinutes: 0,
				averageViewDurationSecondsWeighted: 0,
				averageViewDurationPercentageWeighted: 0,
				likes: 0,
				dislikes: 0,
				comments: 0,
				shares: 0,
				subscribersGained: 0,
				subscribersLost: 0,
				videosAddedToPlaylists: 0,
				videosRemovedFromPlaylists: 0,
				daysTracked: 0
			};

			entry.views += views;
			entry.liveViews += Number(row?.liveViews || 0);
			entry.subscribedViews += Number(row?.subscribedViews || 0);
			entry.redViews += Number(row?.redViews || 0);
			entry.watchTimeMinutes += watchTimeMinutes;
			entry.averageViewDurationSecondsWeighted +=
				views * Number(row?.averageViewDurationSeconds || 0);
			entry.averageViewDurationPercentageWeighted +=
				views * Number(row?.averageViewDurationPercentage || 0);
			entry.likes += Number(row?.likes || 0);
			entry.dislikes += Number(row?.dislikes || 0);
			entry.comments += Number(row?.comments || 0);
			entry.shares += Number(row?.shares || 0);
			entry.subscribersGained += Number(row?.subscribersGained || 0);
			entry.subscribersLost += Number(row?.subscribersLost || 0);
			entry.videosAddedToPlaylists += Number(row?.videosAddedToPlaylists || 0);
			entry.videosRemovedFromPlaylists += Number(row?.videosRemovedFromPlaylists || 0);
			entry.daysTracked += 1;
			byVideo.set(videoId, entry);
		}

		const aggregatedRows = Array.from(byVideo.values())
			.map((row) => ({
				...row,
				watchTimeHours: Number((row.watchTimeMinutes / 60).toFixed(2)),
				averageViewDurationSeconds: row.views
					? Number((row.averageViewDurationSecondsWeighted / row.views).toFixed(2))
					: 0,
				averageViewDurationPercentage: row.views
					? Number((row.averageViewDurationPercentageWeighted / row.views).toFixed(2))
					: 0,
				netSubscribers: row.subscribersGained - row.subscribersLost,
				engagements: row.likes + row.comments + row.shares
			}))
			.sort((a, b) => b.views - a.views)
			.slice(0, safeMaxResults);

		let videoDetailsMap: Record<string, any> = {};
		let enrichment = {
			attempted: false,
			status: aggregatedRows.length ? 'skipped' : 'empty',
			message: aggregatedRows.length
				? null
				: 'No YouTube Reporting API daily video rows were found for the selected dates.',
			error: null as string | null
		};

		if (aggregatedRows.length) {
			try {
				const token = await this.youtubeAuthService.getAccessToken();
				videoDetailsMap = await this.fetchVideosMap(
					token.accessToken,
					aggregatedRows.map((row) => row.videoId)
				);
				enrichment = {
					attempted: true,
					status: 'ok',
					message: null,
					error: null
				};
			} catch (err) {
				logToErrorFile(err, 'Error while enriching bulk YouTube daily stats with live metadata');
				this.logger.warn(
					`Bulk YouTube daily stats metadata enrichment failed: ${this.getErrorMessage(err)}`
				);
				enrichment = {
					attempted: true,
					status: 'degraded',
					message:
						'Bulk daily stats were returned from the local Reporting API tables without live YouTube metadata enrichment. Titles, thumbnails, and durations may be incomplete until OAuth is healthy again.',
					error: this.getErrorMessage(err)
				};
			}
		}

		const enrichedRows = aggregatedRows.map((row) => ({
			...row,
			video: videoDetailsMap[row.videoId] || null
		}));

		const result = {
			statusCode: HttpStatus.OK,
			message: 'YouTube bulk daily video stats fetched successfully',
			range,
			maxResults: safeMaxResults,
			data: {
				summary: {
					trackedVideos: byVideo.size,
					totalViews,
					totalWatchTimeMinutes,
					totalWatchTimeHours: Number((totalWatchTimeMinutes / 60).toFixed(2))
				},
				enrichment,
				rows: enrichedRows
			}
		};
		this.setCache(cacheKey, result, enrichment.status === 'degraded' ? 60_000 : 10 * 60_000);
		return this.applyPaginationToRowsResponse(result, page, limit, 10, 100);
	}

	async getBulkTrafficSourceStats(
		startDate?: string,
		endDate?: string,
		maxResults?: number,
		page?: number,
		limit?: number
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const safeMaxResults = this.resolveTopN(maxResults, 10, 100);
		const cacheKey = `youtube:bulk-traffic-sources:${range.startDate}:${range.endDate}:${safeMaxResults}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return this.applyPaginationToRowsResponse(cached, page, limit, 10, 100);

		const rows = await this.youtubeVideoTrafficSourceStatsRepo.findAll({
			where: {
				statDate: {
					[Op.between]: [range.startDate, range.endDate]
				}
			},
			order: [
				['statDate', 'ASC'],
				['views', 'DESC']
			],
			raw: true
		});

		const bySource = new Map<
			string,
			{ trafficSourceType: string; views: number; watchTimeMinutes: number; videoIds: Set<string> }
		>();
		const byVideoSource = new Map<
			string,
			{
				videoId: string;
				channelId: string | null;
				trafficSourceType: string;
				views: number;
				watchTimeMinutes: number;
				daysTracked: number;
			}
		>();

		let totalViews = 0;
		let totalWatchTimeMinutes = 0;

		for (const row of rows as Array<any>) {
			const videoId = String(row?.videoId || '');
			const trafficSourceType = String(row?.trafficSourceType || '');
			if (!videoId || !trafficSourceType) {
				continue;
			}

			const views = Number(row?.views || 0);
			const watchTimeMinutes = Number(row?.watchTimeMinutes || 0);
			totalViews += views;
			totalWatchTimeMinutes += watchTimeMinutes;

			const sourceEntry = bySource.get(trafficSourceType) || {
				trafficSourceType,
				views: 0,
				watchTimeMinutes: 0,
				videoIds: new Set<string>()
			};
			sourceEntry.views += views;
			sourceEntry.watchTimeMinutes += watchTimeMinutes;
			sourceEntry.videoIds.add(videoId);
			bySource.set(trafficSourceType, sourceEntry);

			const videoSourceKey = `${videoId}|${trafficSourceType}`;
			const videoSourceEntry = byVideoSource.get(videoSourceKey) || {
				videoId,
				channelId: row?.channelId ? String(row.channelId) : null,
				trafficSourceType,
				views: 0,
				watchTimeMinutes: 0,
				daysTracked: 0
			};
			videoSourceEntry.views += views;
			videoSourceEntry.watchTimeMinutes += watchTimeMinutes;
			videoSourceEntry.daysTracked += 1;
			byVideoSource.set(videoSourceKey, videoSourceEntry);
		}

		const sourceRows = Array.from(bySource.values())
			.map((row) => ({
				trafficSourceType: row.trafficSourceType,
				views: row.views,
				watchTimeMinutes: row.watchTimeMinutes,
				watchTimeHours: Number((row.watchTimeMinutes / 60).toFixed(2)),
				videoCount: row.videoIds.size,
				viewsContribution: totalViews ? Number(((row.views / totalViews) * 100).toFixed(2)) : 0
			}))
			.sort((a, b) => b.views - a.views);

		const topRows = Array.from(byVideoSource.values())
			.map((row) => ({
				...row,
				watchTimeHours: Number((row.watchTimeMinutes / 60).toFixed(2))
			}))
			.sort((a, b) => b.views - a.views)
			.slice(0, safeMaxResults);

		let videoDetailsMap: Record<string, any> = {};
		let enrichment = {
			attempted: false,
			status: topRows.length ? 'skipped' : 'empty',
			message: topRows.length
				? null
				: 'No YouTube Reporting API traffic-source rows were found for the selected dates.',
			error: null as string | null
		};

		if (topRows.length) {
			try {
				const token = await this.youtubeAuthService.getAccessToken();
				videoDetailsMap = await this.fetchVideosMap(
					token.accessToken,
					topRows.map((row) => row.videoId)
				);
				enrichment = {
					attempted: true,
					status: 'ok',
					message: null,
					error: null
				};
			} catch (err) {
				logToErrorFile(
					err,
					'Error while enriching bulk YouTube traffic source rows with live metadata'
				);
				this.logger.warn(
					`Bulk YouTube traffic source metadata enrichment failed: ${this.getErrorMessage(err)}`
				);
				enrichment = {
					attempted: true,
					status: 'degraded',
					message:
						'Bulk traffic-source stats were returned from the local Reporting API tables without live YouTube metadata enrichment. Titles and thumbnails may be incomplete until OAuth is healthy again.',
					error: this.getErrorMessage(err)
				};
			}
		}

		const enrichedRows = topRows.map((row) => ({
			...row,
			video: videoDetailsMap[row.videoId] || null
		}));

		const result = {
			statusCode: HttpStatus.OK,
			message: 'YouTube bulk traffic-source stats fetched successfully',
			range,
			maxResults: safeMaxResults,
			data: {
				summary: {
					trackedVideoSourcePairs: byVideoSource.size,
					sourceTypes: sourceRows.length,
					totalViews,
					totalWatchTimeMinutes,
					totalWatchTimeHours: Number((totalWatchTimeMinutes / 60).toFixed(2))
				},
				enrichment,
				sources: sourceRows,
				rows: enrichedRows
			}
		};
		this.setCache(cacheKey, result, enrichment.status === 'degraded' ? 60_000 : 10 * 60_000);
		return this.applyPaginationToRowsResponse(result, page, limit, 10, 100);
	}

	async getTopVideos(
		startDate?: string,
		endDate?: string,
		maxResults?: number,
		page?: number,
		limit?: number
	) {
		const pagination = this.resolvePagination(page, limit, 10, 50);
		const range = this.resolveDateRange(startDate, endDate, 30);
		const safeMaxResults =
			Number.isFinite(maxResults) && Number(maxResults) > 0
				? Math.min(Number(maxResults), 50)
				: pagination.shouldPaginate
					? 50
					: 10;
		const cacheKey = `youtube:top-videos:${range.startDate}:${range.endDate}:${safeMaxResults}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return this.applyPaginationToRowsResponse(cached, page, limit, 10, 50);

		try {
			const token = await this.youtubeAuthService.getAccessToken();
			const analyticsResponse = await this.timedGet(
				'youtubeanalytics.reports.top-videos',
				'https://youtubeanalytics.googleapis.com/v2/reports',
				{
					headers: {
						Authorization: `Bearer ${token.accessToken}`
					},
					params: {
						ids: 'channel==MINE',
						startDate: range.startDate,
						endDate: range.endDate,
						dimensions: 'video',
						metrics:
							'views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained',
						sort: '-views',
						maxResults: safeMaxResults
					}
				}
			);

			const rows = analyticsResponse.data?.rows || [];
			const videoIds: string[] = rows.map((row: any[]) => row[0]).filter(Boolean);
			const videoDetailsMap = await this.fetchVideosMap(token.accessToken, videoIds);

			const enrichedRows = rows.map((row: any[]) => {
				const videoId = row[0];
				return {
					videoId,
					analytics: {
						views: row[1],
						estimatedMinutesWatched: row[2],
						averageViewDuration: row[3],
						likes: row[4],
						comments: row[5],
						subscribersGained: row[6]
					},
					video: videoDetailsMap[videoId] || null
				};
			});

			const result = {
				statusCode: HttpStatus.OK,
				message: 'Top YouTube videos fetched successfully',
				data: {
					columnHeaders: analyticsResponse.data?.columnHeaders || [],
					rows: enrichedRows
				},
				range,
				maxResults: safeMaxResults,
				token: {
					tokenType: token.tokenType,
					expiresInSeconds: token.expiresInSeconds,
					expiresAt: token.expiresAt
				}
			};
			this.setCache(cacheKey, result, 10 * 60_000);
			await this.persistAnalyticsSnapshot('top_videos', range, result.data);
			await this.dataCoverageService.recordAttempt({
				platform: 'youtube',
				jobType: 'top_videos',
				metricKey: 'youtube.analytics.top_videos',
				success: true
			});
			return this.applyPaginationToRowsResponse(result, page, limit, 10, 50);
		} catch (err) {
			logToErrorFile(err, 'Error while fetching top YouTube videos');
			await this.recordAnalyticsCoverageFailure('top_videos', 'youtube.analytics.top_videos', err);
			throw new BadGatewayException(
				`Unable to fetch top YouTube videos: ${this.getErrorMessage(err)}${this.getAnalyticsScopeHint(
					err
				)}${this.getAnalyticsAccessHint(err)}`
			);
		}
	}

	async getVideoAnalyticsSummary(
		channelId: string,
		videoId: string,
		startDate?: string,
		endDate?: string
	) {
		if ((startDate && !endDate) || (!startDate && endDate)) {
			throw new BadRequestException(
				'Both startDate and endDate are required when filtering video analytics summary'
			);
		}

		if (startDate) {
			this.parseDateOnlyString(startDate, 'startDate');
		}
		if (endDate) {
			this.parseDateOnlyString(endDate, 'endDate');
		}

		const cacheKey = `youtube:video-summary:${channelId}:${videoId}:${startDate || 'auto'}:${endDate || 'auto'}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		try {
			const token = await this.youtubeAuthService.getAccessToken();
			let video = null;
			let range = this.resolveDateRange(startDate, endDate, 30);

			if (!startDate || !endDate) {
				const videoDetailsMap = await this.fetchVideosMap(
					token.accessToken,
					[videoId],
					'snippet,statistics,contentDetails,liveStreamingDetails,status'
				);
				video = videoDetailsMap[videoId] || null;
				range = this.resolveVideoAnalyticsRange(video, startDate, endDate);
			}

			const analyticsResponse = await this.timedGet(
				'youtubeanalytics.reports.video-summary',
				'https://youtubeanalytics.googleapis.com/v2/reports',
				{
					headers: {
						Authorization: `Bearer ${token.accessToken}`
					},
					params: {
						ids: 'channel==MINE',
						startDate: range.startDate,
						endDate: range.endDate,
						metrics:
							'views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained,subscribersLost',
						filters: `video==${videoId}`
					}
				}
			);

			const row = analyticsResponse.data?.rows?.[0] || [];
			const summary = {
				views: Number(row[0] ?? 0),
				estimatedMinutesWatched: Number(row[1] ?? 0),
				averageViewDuration: Number(row[2] ?? 0),
				likes: Number(row[3] ?? 0),
				comments: Number(row[4] ?? 0),
				subscribersGained: Number(row[5] ?? 0),
				subscribersLost: Number(row[6] ?? 0),
				netSubscribers: Number(row[5] ?? 0) - Number(row[6] ?? 0)
			};

			const result = {
				statusCode: HttpStatus.OK,
				message: 'YouTube video analytics summary fetched successfully',
				data: {
					channelId,
					videoId,
					range,
					analytics: summary,
					video
				},
				token: {
					tokenType: token.tokenType,
					expiresInSeconds: token.expiresInSeconds,
					expiresAt: token.expiresAt
				}
			};
			this.setCache(cacheKey, result, 5 * 60_000);
			return result;
		} catch (err) {
			logToErrorFile(err, 'Error while fetching YouTube video analytics summary');
			throw new BadGatewayException(
				`Unable to fetch YouTube video analytics summary: ${this.getErrorMessage(err)}${this.getAnalyticsScopeHint(
					err
				)}${this.getAnalyticsAccessHint(err)}`
			);
		}
	}

	async getDashboardOverview(
		startDate?: string,
		endDate?: string,
		metricSet?: string,
		timezone?: string
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const normalizedMetricSet = metricSet || 'views,watchTimeHours,subscribersGained';
		const normalizedTimezone = timezone || 'UTC';
		const cacheKey = `youtube:dashboard:overview:${range.startDate}:${range.endDate}:${normalizedMetricSet}:${normalizedTimezone}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const [timeseriesResponse, channelStatsResponse] = await Promise.all([
			this.getAnalyticsTimeseries(range.startDate, range.endDate),
			this.getChannelStats()
		]);

		const rows = timeseriesResponse?.data?.rows || [];
		const chartRows = rows.map((row: any[]) => ({
			date: String(row[0]),
			views: Number(row[1] ?? 0),
			watchTimeHours: Number(row[2] ?? 0) / 60,
			averageViewDurationSeconds: Number(row[3] ?? 0),
			subscribersGained: Number(row[4] ?? 0),
			subscribersLost: Number(row[5] ?? 0)
		}));

		const totals = chartRows.reduce(
			(acc, row) => {
				acc.views += row.views;
				acc.watchTimeHours += row.watchTimeHours;
				acc.subscribersGained += row.subscribersGained;
				acc.subscribersLost += row.subscribersLost;
				return acc;
			},
			{
				views: 0,
				watchTimeHours: 0,
				subscribersGained: 0,
				subscribersLost: 0
			}
		);

		const result = {
			statusCode: HttpStatus.OK,
			message: 'YouTube dashboard overview fetched successfully',
			range,
			metricSet: normalizedMetricSet,
			timezone: normalizedTimezone,
			generatedAt: new Date().toISOString(),
			cacheTtlMs: 10 * 60_000,
			data: {
				series: chartRows,
				totals: {
					...totals,
					netSubscribers: totals.subscribersGained - totals.subscribersLost
				},
				channel: channelStatsResponse?.data?.items?.[0] || null
			}
		};

		this.setCache(cacheKey, result, 10 * 60_000);
		return result;
	}

	async getDashboardContentTable(
		startDate?: string,
		endDate?: string,
		sortBy = 'views',
		order: 'asc' | 'desc' = 'desc',
		page?: number,
		limit?: number,
		maxResults?: number
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const safeSortBy = this.resolveDashboardSortBy(sortBy);
		const safeOrder = String(order).toLowerCase() === 'asc' ? 'asc' : 'desc';
		const safeMaxResults =
			Number.isFinite(maxResults) && Number(maxResults) > 0
				? Math.min(Number(maxResults), 50)
				: 50;
		const cacheKey = `youtube:dashboard:content-table:${range.startDate}:${range.endDate}:${safeSortBy}:${safeOrder}:${safeMaxResults}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return this.applyPaginationToRowsResponse(cached, page, limit, 10, 50);

		const topVideosResponse = await this.getTopVideos(
			range.startDate,
			range.endDate,
			safeMaxResults
		);
		const rows = topVideosResponse?.data?.rows || [];

		const tableRows = rows.map((row: any) => {
			const video = row.video || {};
			const snippet = video.snippet || {};
			const statistics = video.statistics || {};
			const thumbnails = snippet.thumbnails || {};
			const thumbnail =
				thumbnails.medium?.url || thumbnails.high?.url || thumbnails.default?.url || null;

			return {
				videoId: String(row.videoId || ''),
				title: String(snippet.title || ''),
				publishedAt: snippet.publishedAt || null,
				thumbnail,
				views: Number(row.analytics?.views ?? 0),
				watchTimeHours: Number(row.analytics?.estimatedMinutesWatched ?? 0) / 60,
				subscribersGained: Number(row.analytics?.subscribersGained ?? 0),
				likes: Number(row.analytics?.likes ?? 0),
				comments: Number(row.analytics?.comments ?? 0),
				averageViewDurationSeconds: Number(row.analytics?.averageViewDuration ?? 0),
				lifetimeViews: Number(statistics.viewCount ?? 0)
			};
		});

		tableRows.sort((a, b) => {
			const aValue = this.resolveSortableValue(a, safeSortBy);
			const bValue = this.resolveSortableValue(b, safeSortBy);

			if (aValue === bValue) return 0;
			if (safeOrder === 'asc') return aValue > bValue ? 1 : -1;
			return aValue < bValue ? 1 : -1;
		});

		const result = {
			statusCode: HttpStatus.OK,
			message: 'YouTube dashboard content table fetched successfully',
			range,
			sortBy: safeSortBy,
			order: safeOrder,
			generatedAt: new Date().toISOString(),
			cacheTtlMs: 10 * 60_000,
			data: {
				rows: tableRows
			}
		};

		this.setCache(cacheKey, result, 10 * 60_000);
		return this.applyPaginationToRowsResponse(result, page, limit, 10, 50);
	}

	async ingestDailyVideoRetentionStats(
		topN = 10,
		startDate?: string,
		endDate?: string
	) {
		try {
			this.logIngestProgress(
				'video_retention',
				`started retention ingest topN=${topN} startDate=${startDate ?? 'auto'} endDate=${endDate ?? 'auto'}`
			);
			const token = await this.youtubeAuthService.getAccessToken();
			const channelId = await this.getOwnChannelId(token.accessToken);
			const recentRange = this.resolveReportingSafeDateRange(startDate, endDate, 7);
			const videoIds = await this.fetchTopVideoIdsByViews(
				token.accessToken,
				recentRange.startDate,
				recentRange.endDate,
				topN
			);
			this.logIngestProgress(
				'video_retention',
				`resolved channelId=${channelId} and ${videoIds.length} top videos for range=${recentRange.startDate}..${recentRange.endDate}`
			);
			const videoDetailsMap = await this.fetchVideosMap(token.accessToken, videoIds);
			const lastCapturedAtByVideoId = await this.getLatestCapturedAtByVideoId(videoIds);
			const tierSummary = createEmptyTierSummary();

			const dayStart = this.getUtcDayStart(new Date());
			const nextDayStart = new Date(dayStart);
			nextDayStart.setUTCDate(nextDayStart.getUTCDate() + 1);
			let createdCount = 0;
			let updatedCount = 0;

			for (const [index, videoId] of videoIds.entries()) {
				const tier = classifyContentTier(videoDetailsMap[videoId]?.snippet?.publishedAt ?? null);
				tierSummary[tier]++;
				const due = isRefreshDue(tier, lastCapturedAtByVideoId.get(videoId) ?? null);
				const throttled = tier !== 'hot' && (await this.shouldThrottleLowerPriorityYoutubeWork());
				if (!due || throttled) {
					if (due && throttled) {
						tierSummary.skippedForBudget++;
					}
					this.logIngestProgress(
						'video_retention',
						`skipping video ${index + 1}/${videoIds.length}: videoId=${videoId} tier=${tier} due=${due} throttled=${throttled}`
					);
					continue;
				}

				const createdBeforeVideo = createdCount;
				const updatedBeforeVideo = updatedCount;
				this.logIngestProgress(
					'video_retention',
					`processing video ${index + 1}/${videoIds.length}: videoId=${videoId} tier=${tier}`
				);
				const retentionResponse = await this.timedGet(
					'youtubeanalytics.reports.video-retention',
					'https://youtubeanalytics.googleapis.com/v2/reports',
					{
						headers: {
							Authorization: `Bearer ${token.accessToken}`
						},
						params: {
							ids: 'channel==MINE',
							startDate: recentRange.startDate,
							endDate: recentRange.endDate,
							dimensions: 'elapsedVideoTimeRatio',
							metrics: 'audienceWatchRatio,relativeRetentionPerformance',
							filters: `video==${videoId}`,
							sort: 'elapsedVideoTimeRatio'
						}
					}
				);
				const rowCount = Array.isArray(retentionResponse.data?.rows)
					? retentionResponse.data.rows.length
					: 0;

				for (const row of retentionResponse.data?.rows || []) {
					const elapsedRatio = String(row[0]);
					const payload = {
						channelId,
						videoId,
						elapsedVideoTimeRatio: elapsedRatio,
						audienceWatchRatio: row[1] != null ? String(row[1]) : '0',
						relativeRetentionPerformance:
							row[2] != null ? String(row[2]) : null,
						audienceType: null,
						capturedAt: dayStart
					};

					const existing = await this.youtubeVideoRetentionRepo.findOne({
						where: {
							channelId,
							videoId,
							elapsedVideoTimeRatio: elapsedRatio,
							capturedAt: {
								[Op.gte]: dayStart,
								[Op.lt]: nextDayStart
							}
						}
					});

					if (existing) {
						await existing.update(payload);
						updatedCount++;
					} else {
						await this.youtubeVideoRetentionRepo.create(payload);
						createdCount++;
					}
				}
				this.logIngestProgress(
					'video_retention',
					`completed video ${index + 1}/${videoIds.length}: videoId=${videoId} rows=${rowCount} created=${createdCount - createdBeforeVideo} updated=${updatedCount - updatedBeforeVideo}`
				);
			}

			this.invalidateCache(['youtube:retention:']);
			this.logIngestProgress(
				'video_retention',
				`completed retention ingest: created=${createdCount} updated=${updatedCount} topVideos=${videoIds.length}`
			);

			return {
				statusCode: HttpStatus.OK,
				message: 'YouTube daily video retention stats ingested successfully',
				data: {
					channelId,
					range: recentRange,
					topVideosConsidered: videoIds.length,
					createdCount,
					updatedCount,
					capturedAt: dayStart,
					tierSummary
				}
			};
		} catch (err) {
			this.logger.error(
				`YouTube ingest [video_retention] failed: ${this.getErrorMessage(err)}`
			);
			logToErrorFile(err, 'Error while ingesting YouTube video retention stats');
			throw new BadGatewayException(
				`Unable to ingest YouTube video retention stats: ${this.getErrorMessage(err)}${this.getAnalyticsScopeHint(
					err
				)}`
			);
		}
	}

	async ingestDailyGeoDeviceStats(
		targetDate?: string,
		startDate?: string,
		endDate?: string
	) {
		try {
			this.logIngestProgress(
				'geo_device',
				`started geo/device ingest targetDate=${targetDate ?? 'none'} startDate=${startDate ?? 'auto'} endDate=${endDate ?? 'auto'}`
			);
			const token = await this.youtubeAuthService.getAccessToken();
			const channelId = await this.getOwnChannelId(token.accessToken);
			const ingestDates = this.resolveGeoDeviceIngestionDates(
				targetDate,
				startDate,
				endDate
			);
			this.logIngestProgress(
				'geo_device',
				`resolved channelId=${channelId} and ${ingestDates.length} ingestion date(s): ${ingestDates[0]}..${ingestDates[ingestDates.length - 1]}`
			);

			const totalCounts = {
				COUNTRY: { created: 0, updated: 0 },
				DEVICE_TYPE: { created: 0, updated: 0 },
				OPERATING_SYSTEM: { created: 0, updated: 0 }
			};

			for (const [index, ingestDate] of ingestDates.entries()) {
				this.logIngestProgress(
					'geo_device',
					`processing date ${index + 1}/${ingestDates.length}: ${ingestDate}`
				);
				await this.ingestGeoDeviceDimension({
					channelId,
					date: ingestDate,
					token: token.accessToken,
					dimension: 'country',
					dimensionType: YoutubeGeoDeviceDimensionType.COUNTRY,
					counts: totalCounts
				});
				await this.ingestGeoDeviceDimension({
					channelId,
					date: ingestDate,
					token: token.accessToken,
					dimension: 'deviceType',
					dimensionType: YoutubeGeoDeviceDimensionType.DEVICE_TYPE,
					counts: totalCounts
				});
				await this.ingestGeoDeviceDimension({
					channelId,
					date: ingestDate,
					token: token.accessToken,
					dimension: 'operatingSystem',
					dimensionType: YoutubeGeoDeviceDimensionType.OPERATING_SYSTEM,
					counts: totalCounts
				});
			}

			this.invalidateCache(['youtube:geo:', 'youtube:device:']);
			this.logIngestProgress(
				'geo_device',
				`completed geo/device ingest with counts=${JSON.stringify(totalCounts)}`
			);

			const isRange = ingestDates.length > 1;
			return {
				statusCode: HttpStatus.OK,
				message: isRange
					? 'YouTube geo/device stats ingested successfully for date range'
					: 'YouTube daily geo/device stats ingested successfully',
				data: {
					channelId,
					date: isRange ? undefined : ingestDates[0],
					startDate: ingestDates[0],
					endDate: ingestDates[ingestDates.length - 1],
					totalDaysIngested: ingestDates.length,
					counts: totalCounts
				}
			};
		} catch (err) {
			this.logger.error(
				`YouTube ingest [geo_device] failed: ${this.getErrorMessage(err)}`
			);
			logToErrorFile(err, 'Error while ingesting YouTube geo/device stats');
			throw new BadGatewayException(
				`Unable to ingest YouTube geo/device stats: ${this.getErrorMessage(err)}${this.getAnalyticsScopeHint(
					err
				)}`
			);
		}
	}

	async getVideoRetention(channelId: string, videoId: string) {
		const cacheKey = `youtube:retention:video:${channelId}:${videoId}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const latestCapturedAt = (await this.youtubeVideoRetentionRepo.max('capturedAt', {
			where: { channelId, videoId }
		})) as Date | null;

		if (latestCapturedAt) {
			const rows = await this.youtubeVideoRetentionRepo.findAll({
				where: {
					channelId,
					videoId,
					capturedAt: latestCapturedAt
				},
				order: [['elapsedVideoTimeRatio', 'ASC']],
				raw: true
			});

			const result = {
				statusCode: HttpStatus.OK,
				message: 'YouTube video retention fetched successfully',
				data: {
					channelId,
					videoId,
					capturedAt: latestCapturedAt,
					points: rows,
					source: 'database',
					availabilityStatus: rows.length ? 'available' : 'empty_snapshot'
				}
			};
			this.setCache(cacheKey, result, 10 * 60_000);
			return result;
		}

		const fallbackResult = await this.getVideoRetentionFallback(channelId, videoId);
		const ttlMs = fallbackResult?.data?.points?.length ? 10 * 60_000 : 60_000;
		this.setCache(cacheKey, fallbackResult, ttlMs);
		return fallbackResult;
	}

	async getTopTrackedVideoRetention(topN = 10) {
		const cacheKey = `youtube:retention:top-tracked:${topN}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		try {
			const token = await this.youtubeAuthService.getAccessToken();
			const channelId = await this.getOwnChannelId(token.accessToken);
			const recentRange = this.resolveDateRange(undefined, undefined, 7);
			const topVideoIds = await this.fetchTopVideoIdsByViews(
				token.accessToken,
				recentRange.startDate,
				recentRange.endDate,
				topN
			);

			const videos = [];
			for (const videoId of topVideoIds) {
				const latestCapturedAt = (await this.youtubeVideoRetentionRepo.max(
					'capturedAt',
					{
						where: { channelId, videoId }
					}
				)) as Date | null;

				if (!latestCapturedAt) continue;

				const points = await this.youtubeVideoRetentionRepo.findAll({
					where: {
						channelId,
						videoId,
						capturedAt: latestCapturedAt
					},
					order: [['elapsedVideoTimeRatio', 'ASC']],
					raw: true
				});

				videos.push({
					videoId,
					capturedAt: latestCapturedAt,
					points
				});
			}

			const result = {
				statusCode: HttpStatus.OK,
				message: 'Top tracked YouTube video retention fetched successfully',
				data: {
					channelId,
					topN,
					videos
				}
			};
			this.setCache(cacheKey, result, 10 * 60_000);
			return result;
		} catch (err) {
			logToErrorFile(err, 'Error while fetching top tracked retention stats');
			throw new BadGatewayException(
				`Unable to fetch top tracked retention stats: ${this.getErrorMessage(err)}${this.getAnalyticsScopeHint(
					err
				)}`
			);
		}
	}

	async getGeoBreakdown(channelId: string, startDate?: string, endDate?: string) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const cacheKey = `youtube:geo:${channelId}:${range.startDate}:${range.endDate}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const rows = await this.youtubeGeoDeviceStatsRepo.findAll({
			where: {
				channelId,
				dimensionType: YoutubeGeoDeviceDimensionType.COUNTRY,
				date: {
					[Op.between]: [range.startDate, range.endDate]
				}
			},
			order: [
				['date', 'ASC'],
				['views', 'DESC']
			],
			raw: true
		});
		const locationMap = await this.getCountryLocationMap(
			rows.map((row) => String(row.dimensionValue || ''))
		);

		const result = {
			statusCode: HttpStatus.OK,
			message: 'YouTube geo breakdown fetched successfully',
			data: rows.map((row) => {
				const countryCode = this.normalizeCountryCode(row.dimensionValue);
				const location = countryCode ? locationMap.get(countryCode) : null;
				return {
					...row,
					countryCode,
					slug: location?.slug ?? null,
					geoName: location?.name ?? null,
					lat: location?.latitude ?? null,
					lng: location?.longitude ?? null
				};
			}),
			range
		};
		this.setCache(cacheKey, result, 10 * 60_000);
		return result;
	}

	async getDeviceBreakdown(channelId: string, startDate?: string, endDate?: string) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const cacheKey = `youtube:device:${channelId}:${range.startDate}:${range.endDate}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const rows = await this.youtubeGeoDeviceStatsRepo.findAll({
			where: {
				channelId,
				dimensionType: {
					[Op.in]: [
						YoutubeGeoDeviceDimensionType.DEVICE_TYPE,
						YoutubeGeoDeviceDimensionType.OPERATING_SYSTEM
					]
				},
				date: {
					[Op.between]: [range.startDate, range.endDate]
				}
			},
			order: [
				['date', 'ASC'],
				['dimensionType', 'ASC'],
				['views', 'DESC']
			],
			raw: true
		});

		const result = {
			statusCode: HttpStatus.OK,
			message: 'YouTube device/OS breakdown fetched successfully',
			data: {
				deviceType: rows.filter(
					(row) =>
						row.dimensionType === YoutubeGeoDeviceDimensionType.DEVICE_TYPE
				),
				operatingSystem: rows.filter(
					(row) =>
						row.dimensionType === YoutubeGeoDeviceDimensionType.OPERATING_SYSTEM
				)
			},
			range
		};
		this.setCache(cacheKey, result, 10 * 60_000);
		return result;
	}

	async ingestDailyVideoGeoStats(
		topN = 10,
		targetDate?: string,
		startDate?: string,
		endDate?: string
	) {
		try {
			this.logIngestProgress(
				'video_geo',
				`started video geography ingest topN=${topN} targetDate=${targetDate ?? 'none'} startDate=${startDate ?? 'auto'} endDate=${endDate ?? 'auto'}`
			);
			const token = await this.youtubeAuthService.getAccessToken();
			const channelId = await this.getOwnChannelId(token.accessToken);
			const ingestDates = this.resolveGeoDeviceIngestionDates(
				targetDate,
				startDate,
				endDate
			);
			const safeTopN = this.resolveTopN(topN, 10, 50);
			let createdCount = 0;
			let updatedCount = 0;
			let queriedVideosCount = 0;
			const tierSummary = createEmptyTierSummary();
			this.logIngestProgress(
				'video_geo',
				`resolved channelId=${channelId} and ${ingestDates.length} ingestion date(s) with topN=${safeTopN}`
			);

			for (const [dateIndex, ingestDate] of ingestDates.entries()) {
				const topVideoIds = await this.fetchTopVideoIdsByViews(
					token.accessToken,
					ingestDate,
					ingestDate,
					safeTopN
				);
				const videoDetailsMap = await this.fetchVideosMap(token.accessToken, topVideoIds);
				const alreadyCapturedVideoIds = await this.getExistingVideoGeoVideoIds(
					channelId,
					ingestDate,
					topVideoIds
				);
				this.logIngestProgress(
					'video_geo',
					`processing date ${dateIndex + 1}/${ingestDates.length}: ${ingestDate} with ${topVideoIds.length} top video(s)`
				);

				for (const [videoIndex, videoId] of topVideoIds.entries()) {
					const tier = classifyContentTier(videoDetailsMap[videoId]?.snippet?.publishedAt ?? null);
					tierSummary[tier]++;

					if (alreadyCapturedVideoIds.has(videoId)) {
						// This (video, date) pair is already a finalized historical row — re-fetching
						// won't change it, so skip regardless of tier.
						continue;
					}

					const throttled = tier !== 'hot' && (await this.shouldThrottleLowerPriorityYoutubeWork());
					if (throttled) {
						tierSummary.skippedForBudget++;
						this.logIngestProgress(
							'video_geo',
							`skipping video ${videoIndex + 1}/${topVideoIds.length} for ${ingestDate}: videoId=${videoId} tier=${tier} (budget throttled)`
						);
						continue;
					}

					const createdBeforeVideo = createdCount;
					const updatedBeforeVideo = updatedCount;
					queriedVideosCount++;
					this.logIngestProgress(
						'video_geo',
						`processing video ${videoIndex + 1}/${topVideoIds.length} for ${ingestDate}: videoId=${videoId} tier=${tier}`
					);
					const response = await this.timedGet(
						'youtubeanalytics.reports.video-country',
						'https://youtubeanalytics.googleapis.com/v2/reports',
						{
							headers: {
								Authorization: `Bearer ${token.accessToken}`
							},
							params: {
								ids: 'channel==MINE',
								startDate: ingestDate,
								endDate: ingestDate,
								dimensions: 'country',
								metrics: 'views,estimatedMinutesWatched',
								filters: `video==${videoId}`,
								sort: '-views',
								maxResults: 500
							}
						}
					);
					const rowCount = Array.isArray(response.data?.rows)
						? response.data.rows.length
						: 0;

					for (const row of response.data?.rows || []) {
						const payload = {
							channelId,
							videoId,
							date: ingestDate,
							countryCode: String(row[0] ?? ''),
							views: String(row[1] ?? 0),
							estimatedMinutesWatched: String(row[2] ?? 0)
						};

						if (!payload.countryCode) continue;

						// No existence check needed here: alreadyCapturedVideoIds already
						// guarantees this (video, date) pair has no prior rows, so every
						// country row below is necessarily new.
						await this.youtubeVideoGeoStatsRepo.create(payload);
						createdCount++;
					}
					this.logIngestProgress(
						'video_geo',
						`completed video ${videoIndex + 1}/${topVideoIds.length} for ${ingestDate}: videoId=${videoId} rows=${rowCount} created=${createdCount - createdBeforeVideo} updated=${updatedCount - updatedBeforeVideo}`
					);
				}
			}

			this.invalidateCache([
				'youtube:geo-hotspot:',
				'youtube:geo-country-videos:',
				'youtube:geo-video-countries:'
			]);
			this.logIngestProgress(
				'video_geo',
				`completed video geography ingest: queriedVideos=${queriedVideosCount} created=${createdCount} updated=${updatedCount}`
			);

			return {
				statusCode: HttpStatus.OK,
				message: 'YouTube daily video geography stats ingested successfully',
				data: {
					channelId,
					topN: safeTopN,
					startDate: ingestDates[0],
					endDate: ingestDates[ingestDates.length - 1],
					totalDaysIngested: ingestDates.length,
					queriedVideosCount,
					createdCount,
					updatedCount,
					tierSummary
				}
			};
		} catch (err) {
			this.logger.error(
				`YouTube ingest [video_geo] failed: ${this.getErrorMessage(err)}`
			);
			logToErrorFile(err, 'Error while ingesting YouTube video geography stats');
			throw new BadGatewayException(
				`Unable to ingest YouTube video geography stats: ${this.getErrorMessage(err)}${this.getAnalyticsScopeHint(
					err
				)}`
			);
		}
	}

	async getGeoHotspot(
		channelId: string,
		startDate?: string,
		endDate?: string,
		metric?: string
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const safeMetric = this.resolveGeoMetric(metric);
		const cacheKey = `youtube:geo-hotspot:${channelId}:${range.startDate}:${range.endDate}:${safeMetric}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const rows = await this.youtubeGeoDeviceStatsRepo.findAll({
			where: {
				channelId,
				dimensionType: YoutubeGeoDeviceDimensionType.COUNTRY,
				date: {
					[Op.between]: [range.startDate, range.endDate]
				}
			},
			order: [
				['date', 'ASC'],
				['views', 'DESC']
			],
			raw: true
		});

		const countryMap = new Map<
			string,
			{
				countryCode: string;
				views: number;
				estimatedMinutesWatched: number;
				dateCount: number;
			}
		>();

		for (const row of rows) {
			const countryCode = this.normalizeCountryCode(row.dimensionValue);
			if (!countryCode) continue;

			const existing = countryMap.get(countryCode) || {
				countryCode,
				views: 0,
				estimatedMinutesWatched: 0,
				dateCount: 0
			};

			existing.views += Number(row.views ?? 0);
			existing.estimatedMinutesWatched += Number(row.estimatedMinutesWatched ?? 0);
			existing.dateCount += 1;
			countryMap.set(countryCode, existing);
		}
		const locationMap = await this.getCountryLocationMap(Array.from(countryMap.keys()));

		const countries = Array.from(countryMap.values())
			.map((country) => ({
				...country,
				slug: locationMap.get(country.countryCode)?.slug ?? null,
				geoName: locationMap.get(country.countryCode)?.name ?? null,
				lat: locationMap.get(country.countryCode)?.latitude ?? null,
				lng: locationMap.get(country.countryCode)?.longitude ?? null,
				watchTimeHours: country.estimatedMinutesWatched / 60,
				metricValue: this.resolveMetricValue(country, safeMetric)
			}))
			.sort((a, b) => b.metricValue - a.metricValue);

		const totals = countries.reduce(
			(acc, country) => {
				acc.views += country.views;
				acc.estimatedMinutesWatched += country.estimatedMinutesWatched;
				return acc;
			},
			{
				views: 0,
				estimatedMinutesWatched: 0
			}
		);

		const result = {
			statusCode: HttpStatus.OK,
			message: 'YouTube geo hotspot data fetched successfully',
			range,
			metric: safeMetric,
			data: {
				countries,
				totals: {
					...totals,
					watchTimeHours: totals.estimatedMinutesWatched / 60
				}
			}
		};

		this.setCache(cacheKey, result, 10 * 60_000);
		return result;
	}

	async getGeoCountryVideos(
		channelId: string,
		countryCode: string,
		startDate?: string,
		endDate?: string,
		sortBy = 'views',
		order: 'asc' | 'desc' = 'desc',
		page?: number,
		limit?: number
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const normalizedCountryCode = String(countryCode || '').toUpperCase();
		const safeSortBy = this.resolveGeoVideoSortBy(sortBy);
		const safeOrder = String(order).toLowerCase() === 'asc' ? 'asc' : 'desc';
		const cacheKey = `youtube:geo-country-videos:${channelId}:${normalizedCountryCode}:${range.startDate}:${range.endDate}:${safeSortBy}:${safeOrder}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) {
			return this.applyPaginationToRowsResponse(cached, page, limit, 10, 100);
		}

		const rows = await this.youtubeVideoGeoStatsRepo.findAll({
			where: {
				channelId,
				countryCode: normalizedCountryCode,
				date: {
					[Op.between]: [range.startDate, range.endDate]
				}
			},
			order: [
				['date', 'ASC'],
				['views', 'DESC']
			],
			raw: true
		});

		const videoMap = new Map<
			string,
			{
				videoId: string;
				views: number;
				estimatedMinutesWatched: number;
			}
		>();

		for (const row of rows) {
			const videoId = String(row.videoId || '');
			if (!videoId) continue;

			const existing = videoMap.get(videoId) || {
				videoId,
				views: 0,
				estimatedMinutesWatched: 0
			};

			existing.views += Number(row.views ?? 0);
			existing.estimatedMinutesWatched += Number(row.estimatedMinutesWatched ?? 0);
			videoMap.set(videoId, existing);
		}

		let videoDetailsMap: Record<string, any> = {};
		let enrichment = {
			attempted: videoMap.size > 0,
			status: videoMap.size > 0 ? 'complete' : 'skipped',
			message: videoMap.size > 0
				? null
				: 'No country video rows were found for the requested filters, so live YouTube metadata enrichment was skipped.',
			error: null as string | null
		};

		if (videoMap.size) {
			try {
				const token = await this.youtubeAuthService.getAccessToken();
				videoDetailsMap = await this.fetchVideosMap(
					token.accessToken,
					Array.from(videoMap.keys())
				);
			} catch (err) {
				logToErrorFile(
					err,
					'Error while enriching YouTube country top videos with live metadata'
				);
				this.logger.warn(
					`YouTube country top videos metadata enrichment failed: ${this.getErrorMessage(
						err
					)}`
				);
				enrichment = {
					attempted: true,
					status: 'degraded',
					message:
						'Stored country video stats were returned without live YouTube metadata. Titles, thumbnails, tags, and lifetime counters may be incomplete until YouTube OAuth is fixed.',
					error: this.getErrorMessage(err)
				};
			}
		}

		const tableRows = this.buildGeoCountryVideoRows(
			channelId,
			range,
			Array.from(videoMap.values()),
			videoDetailsMap,
			safeSortBy,
			safeOrder
		);

		const result = {
			statusCode: HttpStatus.OK,
			message: 'YouTube country top videos fetched successfully',
			range,
			countryCode: normalizedCountryCode,
			country: await this.getCountryLocation(normalizedCountryCode),
			sortBy: safeSortBy,
			order: safeOrder,
			data: {
				rows: tableRows,
				enrichment
			}
		};

		this.setCache(cacheKey, result, enrichment.status === 'degraded' ? 60_000 : 10 * 60_000);
		return this.applyPaginationToRowsResponse(result, page, limit, 10, 100);
	}

	async getOverallTagPerformance(
		startDate?: string,
		endDate?: string,
		maxResults?: number,
		sortBy = 'views',
		order: 'asc' | 'desc' = 'desc',
		page?: number,
		limit?: number
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const safeSortBy = this.resolveTagSortBy(sortBy);
		const safeOrder = String(order).toLowerCase() === 'asc' ? 'asc' : 'desc';
		const safeMaxResults = this.resolveTopN(maxResults, 25, 50);
		const cacheKey = `youtube:tags:overall:${range.startDate}:${range.endDate}:${safeMaxResults}:${safeSortBy}:${safeOrder}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return this.applyPaginationToRowsResponse(cached, page, limit, 10, 100);

		const topVideosResponse = await this.getTopVideos(
			range.startDate,
			range.endDate,
			safeMaxResults
		);
		const videoRows = (topVideosResponse?.data?.rows || []).map((row: any) =>
			this.normalizeTopVideoAnalyticsRow(row)
		);
		const tagRows = this.buildOverallTagRows(videoRows, safeSortBy, safeOrder);

		const result = {
			statusCode: HttpStatus.OK,
			message: 'YouTube overall tag performance fetched successfully',
			range,
			sortBy: safeSortBy,
			order: safeOrder,
			maxResults: safeMaxResults,
			data: {
				rows: tagRows
			}
		};
		this.setCache(cacheKey, result, 10 * 60_000);
		return this.applyPaginationToRowsResponse(result, page, limit, 10, 100);
	}

	async getCountryTagPerformance(
		channelId: string,
		countryCode: string,
		startDate?: string,
		endDate?: string,
		sortBy = 'views',
		order: 'asc' | 'desc' = 'desc',
		page?: number,
		limit?: number
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const normalizedCountryCode = this.normalizeCountryCode(countryCode);
		const safeSortBy = this.resolveCountryTagSortBy(sortBy);
		const safeOrder = String(order).toLowerCase() === 'asc' ? 'asc' : 'desc';
		const cacheKey = `youtube:tags:country:${channelId}:${normalizedCountryCode}:${range.startDate}:${range.endDate}:${safeSortBy}:${safeOrder}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return this.applyPaginationToRowsResponse(cached, page, limit, 10, 100);

		const countryVideosResponse = await this.getGeoCountryVideos(
			channelId,
			normalizedCountryCode,
			range.startDate,
			range.endDate,
			'views',
			'desc'
		);
		const rows = Array.isArray(countryVideosResponse?.data?.rows)
			? countryVideosResponse.data.rows
			: [];
		const tagRows = this.buildCountryTagRows(rows, safeSortBy, safeOrder);

		const result = {
			statusCode: HttpStatus.OK,
			message: 'YouTube country tag performance fetched successfully',
			range,
			channelId,
			countryCode: normalizedCountryCode,
			country: countryVideosResponse?.country || (await this.getCountryLocation(normalizedCountryCode)),
			sortBy: safeSortBy,
			order: safeOrder,
			data: {
				rows: tagRows
			}
		};
		this.setCache(cacheKey, result, 10 * 60_000);
		return this.applyPaginationToRowsResponse(result, page, limit, 10, 100);
	}

	async getTagDetail(
		tag: string,
		startDate?: string,
		endDate?: string,
		maxResults?: number,
		channelId?: string,
		countryCode?: string,
		page?: number,
		limit?: number
	) {
		const normalizedTag = this.normalizeTag(tag);
		if (!normalizedTag) {
			throw new BadRequestException('tag is required');
		}

		const range = this.resolveDateRange(startDate, endDate, 30);
		const normalizedCountryCode = countryCode
			? this.normalizeCountryCode(countryCode)
			: '';
		const safeMaxResults = this.resolveTopN(maxResults, 25, 50);
		const cacheKey = `youtube:tags:detail:${normalizedTag}:${range.startDate}:${range.endDate}:${safeMaxResults}:${channelId || ''}:${normalizedCountryCode}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return this.applyPaginationToRowsResponse(cached, page, limit, 10, 100);

		let scope: 'overall' | 'country' = 'overall';
		let sourceRows: any[] = [];
		let resolvedChannelId = channelId || '';
		let country: any = null;

		if (channelId && normalizedCountryCode) {
			scope = 'country';
			const countryVideosResponse = await this.getGeoCountryVideos(
				channelId,
				normalizedCountryCode,
				range.startDate,
				range.endDate,
				'views',
				'desc'
			);
			sourceRows = Array.isArray(countryVideosResponse?.data?.rows)
				? countryVideosResponse.data.rows
				: [];
			country = countryVideosResponse?.country || null;
			resolvedChannelId = channelId;
		} else {
			const topVideosResponse = await this.getTopVideos(
				range.startDate,
				range.endDate,
				safeMaxResults
			);
			sourceRows = (topVideosResponse?.data?.rows || []).map((row: any) =>
				this.normalizeTopVideoAnalyticsRow(row)
			);
			resolvedChannelId = String(sourceRows[0]?.channelId || '');
		}

		const matchingRows = sourceRows.filter((row) =>
			this.getNormalizedTagsFromRow(row).includes(normalizedTag)
		);
		const tagSummary = this.buildTagDetailSummary(normalizedTag, matchingRows, scope);
		const geoBreakdown = resolvedChannelId
			? await this.buildTagCountryBreakdown(
				resolvedChannelId,
				matchingRows.map((row) => String(row.videoId || '')).filter(Boolean),
				range
			)
			: [];

		const result = {
			statusCode: HttpStatus.OK,
			message: 'YouTube tag detail fetched successfully',
			range,
			tag: tagSummary.tag,
			scope,
			channelId: resolvedChannelId || null,
			countryCode: normalizedCountryCode || null,
			country,
			maxResults: scope === 'overall' ? safeMaxResults : undefined,
			data: {
				summary: tagSummary.summary,
				rows: matchingRows,
				topCountries: geoBreakdown
			}
		};
		this.setCache(cacheKey, result, 10 * 60_000);
		return this.applyPaginationToRowsResponse(result, page, limit, 10, 100);
	}

	async getVideoGeoBreakdown(
		channelId: string,
		videoId: string,
		startDate?: string,
		endDate?: string,
		metric?: string
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const safeMetric = this.resolveGeoMetric(metric);
		const cacheKey = `youtube:geo-video-countries:${channelId}:${videoId}:${range.startDate}:${range.endDate}:${safeMetric}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const rows = await this.youtubeVideoGeoStatsRepo.findAll({
			where: {
				channelId,
				videoId,
				date: {
					[Op.between]: [range.startDate, range.endDate]
				}
			},
			order: [
				['date', 'ASC'],
				['views', 'DESC']
			],
			raw: true
		});

		const countryMap = new Map<
			string,
			{
				countryCode: string;
				views: number;
				estimatedMinutesWatched: number;
			}
		>();
		const timelineMap = new Map<
			string,
			{
				date: string;
				views: number;
				estimatedMinutesWatched: number;
			}
		>();

		for (const row of rows) {
			const countryCode = this.normalizeCountryCode(row.countryCode);
			if (countryCode) {
				const existingCountry = countryMap.get(countryCode) || {
					countryCode,
					views: 0,
					estimatedMinutesWatched: 0
				};
				existingCountry.views += Number(row.views ?? 0);
				existingCountry.estimatedMinutesWatched += Number(
					row.estimatedMinutesWatched ?? 0
				);
				countryMap.set(countryCode, existingCountry);
			}

			const dateKey = String(row.date || '');
			if (dateKey) {
				const existingDate = timelineMap.get(dateKey) || {
					date: dateKey,
					views: 0,
					estimatedMinutesWatched: 0
				};
				existingDate.views += Number(row.views ?? 0);
				existingDate.estimatedMinutesWatched += Number(
					row.estimatedMinutesWatched ?? 0
				);
				timelineMap.set(dateKey, existingDate);
			}
		}

		const locationMap = await this.getCountryLocationMap(Array.from(countryMap.keys()));
		const countries = Array.from(countryMap.values())
			.map((country) => ({
				...country,
				slug: locationMap.get(country.countryCode)?.slug ?? null,
				geoName: locationMap.get(country.countryCode)?.name ?? null,
				lat: locationMap.get(country.countryCode)?.latitude ?? null,
				lng: locationMap.get(country.countryCode)?.longitude ?? null,
				watchTimeHours: country.estimatedMinutesWatched / 60,
				metricValue: this.resolveMetricValue(country, safeMetric)
			}))
			.sort((a, b) => b.metricValue - a.metricValue);
		const timeline = Array.from(timelineMap.values())
			.map((entry) => ({
				...entry,
				watchTimeHours: entry.estimatedMinutesWatched / 60,
				metricValue: this.resolveMetricValue(entry, safeMetric)
			}))
			.sort((a, b) => String(a.date).localeCompare(String(b.date)));

		const result = {
			statusCode: HttpStatus.OK,
			message: 'YouTube video geography breakdown fetched successfully',
			range,
			metric: safeMetric,
			data: {
				channelId,
				videoId,
				video: null,
				countries,
				timeline
			}
		};

		this.setCache(cacheKey, result, 10 * 60_000);
		return result;
	}

	private async ingestGeoDeviceDimension({
		channelId,
		date,
		token,
		dimension,
		dimensionType,
		counts
	}: {
		channelId: string;
		date: string;
		token: string;
		dimension: 'country' | 'deviceType' | 'operatingSystem';
		dimensionType: YoutubeGeoDeviceDimensionType;
		counts: Record<string, { created: number; updated: number }>;
	}) {
		const createdBefore = counts[dimensionType].created;
		const updatedBefore = counts[dimensionType].updated;
		this.logIngestProgress(
			'geo_device',
			`fetching ${dimensionType} rows for date=${date}`
		);
		const response = await this.timedGet(
			`youtubeanalytics.reports.${dimension}`,
			'https://youtubeanalytics.googleapis.com/v2/reports',
			{
				headers: {
					Authorization: `Bearer ${token}`
				},
				params: {
					ids: 'channel==MINE',
					startDate: date,
					endDate: date,
					dimensions: dimension,
					metrics: 'views,estimatedMinutesWatched',
					sort: '-views',
					maxResults: 500
				}
			}
		);
		const rowCount = Array.isArray(response.data?.rows) ? response.data.rows.length : 0;

		for (const row of response.data?.rows || []) {
			const statDate = date;
			const dimensionValue = String(row[0]);
			const payload = {
				channelId,
				date: statDate,
				dimensionType,
				dimensionValue,
				views: String(row[1] ?? 0),
				estimatedMinutesWatched: String(row[2] ?? 0)
			};

			const existing = await this.youtubeGeoDeviceStatsRepo.findOne({
				where: {
					channelId,
					date: statDate,
					dimensionType,
					dimensionValue
				}
			});

			if (existing) {
				await existing.update(payload);
				counts[dimensionType].updated++;
			} else {
				await this.youtubeGeoDeviceStatsRepo.create(payload);
				counts[dimensionType].created++;
			}
		}
		this.logIngestProgress(
			'geo_device',
			`completed ${dimensionType} for date=${date}: rows=${rowCount} created=${counts[dimensionType].created - createdBefore} updated=${counts[dimensionType].updated - updatedBefore}`
		);
	}

	private async fetchTopVideoIdsByViews(
		accessToken: string,
		startDate: string,
		endDate: string,
		maxResults: number
	) {
		const response = await this.timedGet(
			'youtubeanalytics.reports.top-video-ids',
			'https://youtubeanalytics.googleapis.com/v2/reports',
			{
				headers: {
					Authorization: `Bearer ${accessToken}`
				},
				params: {
					ids: 'channel==MINE',
					startDate,
					endDate,
					dimensions: 'video',
					metrics: 'views',
					sort: '-views',
					maxResults
				}
			}
		);

		return (response.data?.rows || []).map((row: any[]) => String(row[0]));
	}

	private normalizeCountryCode(value?: string) {
		return String(value || '').trim().toUpperCase();
	}

	private normalizeTag(value?: string) {
		return String(value || '').trim().toLowerCase();
	}

	private async getCountryLocationMap(countryCodes: string[]) {
		const normalizedCodes = Array.from(
			new Set(countryCodes.map((code) => this.normalizeCountryCode(code)).filter(Boolean))
		);
		if (!normalizedCodes.length) {
			return new Map<string, any>();
		}

		const locations = await this.countryListRepo.findAll({
			where: {
				countryCode: {
					[Op.in]: normalizedCodes
				}
			},
			raw: true
		});

		return locations.reduce((map, location) => {
			const countryCode = this.normalizeCountryCode(location.countryCode);
			if (countryCode) {
				map.set(countryCode, location);
			}
			return map;
		}, new Map<string, any>());
	}

	private async getCountryLocation(countryCode: string) {
		const locationMap = await this.getCountryLocationMap([countryCode]);
		const location = locationMap.get(this.normalizeCountryCode(countryCode));
		if (!location) {
			return null;
		}

		return {
			countryCode: this.normalizeCountryCode(countryCode),
			slug: location.slug ?? null,
			geoName: location.name ?? null,
			lat: location.latitude ?? null,
			lng: location.longitude ?? null
		};
	}

	private async fetchOwnLiveBroadcasts(accessToken: string, maxResults = 50) {
		const rows: any[] = [];
		let pageToken: string | undefined;

		do {
			const response = await this.timedGet(
				'youtube.liveBroadcasts.list.mine',
				'https://www.googleapis.com/youtube/v3/liveBroadcasts',
				{
					headers: {
						Authorization: `Bearer ${accessToken}`
					},
					params: {
						part: 'id,snippet,contentDetails,status',
						mine: true,
						maxResults: Math.min(maxResults, 50),
						...(pageToken ? { pageToken } : {})
					}
				}
			);

			rows.push(...(response.data?.items || []));
			pageToken = response.data?.nextPageToken;
		} while (pageToken && rows.length < maxResults);

		return rows.slice(0, maxResults);
	}

	private filterBroadcastsForRange(
		broadcasts: any[],
		range: { startDate: string; endDate: string }
	) {
		const startMs = new Date(`${range.startDate}T00:00:00.000Z`).getTime();
		const endMs = new Date(`${range.endDate}T23:59:59.999Z`).getTime();

		return broadcasts.filter((broadcast: any) => {
			const status = String(broadcast?.status?.lifeCycleStatus || '').toLowerCase();
			if (!['live', 'complete', 'ready', 'created', 'livestarting'].includes(status)) {
				return false;
			}

			const actualStartMs = this.parseOptionalDateMs(broadcast?.snippet?.actualStartTime);
			const scheduledStartMs = this.parseOptionalDateMs(broadcast?.snippet?.scheduledStartTime);
			const publishedAtMs = this.parseOptionalDateMs(broadcast?.snippet?.publishedAt);
			const actualEndMs = this.parseOptionalDateMs(broadcast?.snippet?.actualEndTime);
			const startCandidate = actualStartMs ?? scheduledStartMs ?? publishedAtMs;
			const endCandidate =
				actualEndMs ??
				(status === 'live' || status === 'livestarting' ? Date.now() : null) ??
				startCandidate;

			if (startCandidate == null) {
				return false;
			}

			return startCandidate <= endMs && (endCandidate == null || endCandidate >= startMs);
		});
	}

	private async fetchLiveAnalyticsByDay(
		accessToken: string,
		videoIds: string[],
		startDate: string,
		endDate: string
	) {
		const rows = await this.fetchLiveAnalyticsRows(accessToken, videoIds, startDate, endDate, 'day');
		return rows
			.map((row: any) => ({
				day: row.dimensionValue,
				views: row.views,
				estimatedMinutesWatched: row.estimatedMinutesWatched,
				watchTimeHours: Number(row.estimatedMinutesWatched || 0) / 60,
				averageViewDurationSeconds: row.averageViewDurationSeconds,
				subscribersGained: row.subscribersGained,
				subscribersLost: row.subscribersLost,
				netSubscribers: Number(row.subscribersGained || 0) - Number(row.subscribersLost || 0)
			}))
			.sort((a: any, b: any) => String(a.day).localeCompare(String(b.day)));
	}

	private async fetchLiveAnalyticsByCountry(
		accessToken: string,
		videoIds: string[],
		startDate: string,
		endDate: string
	) {
		if (!videoIds.length) {
			return [];
		}

		const videoChunks = this.chunkValues(videoIds, 20);
		const countryMap = new Map<
			string,
			{
				countryCode: string;
				views: number;
				estimatedMinutesWatched: number;
			}
		>();

		for (const chunk of videoChunks) {
			const response = await this.timedGet(
				'youtubeanalytics.reports.live.country',
				'https://youtubeanalytics.googleapis.com/v2/reports',
				{
					headers: {
						Authorization: `Bearer ${accessToken}`
					},
					params: {
						ids: 'channel==MINE',
						startDate,
						endDate,
						dimensions: 'country',
						metrics: 'views,estimatedMinutesWatched',
						filters: `video==${chunk.join(',')}`,
						sort: '-views',
						maxResults: 500
					}
				}
			);

			for (const row of response.data?.rows || []) {
				const countryCode = this.normalizeCountryCode(row[0]);
				if (!countryCode) continue;
				const existing = countryMap.get(countryCode) || {
					countryCode,
					views: 0,
					estimatedMinutesWatched: 0
				};
				existing.views += Number(row[1] ?? 0);
				existing.estimatedMinutesWatched += Number(row[2] ?? 0);
				countryMap.set(countryCode, existing);
			}
		}

		return Array.from(countryMap.values()).sort(
			(a: any, b: any) => Number(b.views || 0) - Number(a.views || 0)
		);
	}

	private async fetchLiveAnalyticsRows(
		accessToken: string,
		videoIds: string[],
		startDate: string,
		endDate: string,
		dimension: 'day' | 'country'
	) {
		if (!videoIds.length) {
			return [];
		}

		const metrics =
			'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost';
		const videoChunks = this.chunkValues(videoIds, 20);
		const dimensionMap = new Map<
			string,
			{
				dimensionValue: string;
				views: number;
				estimatedMinutesWatched: number;
				weightedAverageDuration: number;
				subscribersGained: number;
				subscribersLost: number;
			}
		>();

		for (const chunk of videoChunks) {
			const response = await this.timedGet(
				`youtubeanalytics.reports.live.${dimension}`,
				'https://youtubeanalytics.googleapis.com/v2/reports',
				{
					headers: {
						Authorization: `Bearer ${accessToken}`
					},
					params: {
						ids: 'channel==MINE',
						startDate,
						endDate,
						dimensions: dimension,
						metrics,
						filters: `video==${chunk.join(',')}`,
						sort: dimension === 'day' ? 'day' : '-views',
						maxResults: dimension === 'day' ? 366 : 500
					}
				}
			);

			for (const row of response.data?.rows || []) {
				const dimensionValue = String(row[0] ?? '');
				if (!dimensionValue) continue;

				const existing = dimensionMap.get(dimensionValue) || {
					dimensionValue,
					views: 0,
					estimatedMinutesWatched: 0,
					weightedAverageDuration: 0,
					subscribersGained: 0,
					subscribersLost: 0
				};
				const rowViews = Number(row[1] ?? 0);
				const rowAverageDuration = Number(row[3] ?? 0);

				existing.views += rowViews;
				existing.estimatedMinutesWatched += Number(row[2] ?? 0);
				existing.weightedAverageDuration += rowViews * rowAverageDuration;
				existing.subscribersGained += Number(row[4] ?? 0);
				existing.subscribersLost += Number(row[5] ?? 0);
				dimensionMap.set(dimensionValue, existing);
			}
		}

		return Array.from(dimensionMap.values()).map((row) => ({
			dimensionValue: row.dimensionValue,
			views: row.views,
			estimatedMinutesWatched: row.estimatedMinutesWatched,
			averageViewDurationSeconds: row.views
				? Number((row.weightedAverageDuration / row.views).toFixed(2))
				: 0,
			subscribersGained: row.subscribersGained,
			subscribersLost: row.subscribersLost
		}));
	}

	private buildLiveBroadcastRow(broadcast: any, video: any) {
		const snippet = broadcast?.snippet || {};
		const status = broadcast?.status || {};
		const contentDetails = broadcast?.contentDetails || {};
		const videoSnippet = video?.snippet || {};
		const videoStats = video?.statistics || {};
		const liveStreamingDetails = video?.liveStreamingDetails || {};
		return {
			videoId: String(broadcast?.id || ''),
			title: String(snippet?.title || videoSnippet?.title || ''),
			publishedAt: snippet?.publishedAt || videoSnippet?.publishedAt || null,
			scheduledStartTime: snippet?.scheduledStartTime || liveStreamingDetails?.scheduledStartTime || null,
			actualStartTime: snippet?.actualStartTime || liveStreamingDetails?.actualStartTime || null,
			actualEndTime: snippet?.actualEndTime || liveStreamingDetails?.actualEndTime || null,
			liveBroadcastContent: videoSnippet?.liveBroadcastContent || null,
			broadcastStatus: status?.lifeCycleStatus || null,
			privacyStatus: status?.privacyStatus || video?.status?.privacyStatus || null,
			recordingStatus: status?.recordingStatus || null,
			enableAutoStart: Boolean(contentDetails?.enableAutoStart ?? false),
			enableAutoStop: Boolean(contentDetails?.enableAutoStop ?? false),
			enableDvr: Boolean(contentDetails?.enableDvr ?? false),
			enableEmbed: Boolean(contentDetails?.enableEmbed ?? false),
			latencyPreference: contentDetails?.latencyPreference || null,
			boundStreamId: contentDetails?.boundStreamId || null,
			liveChatId: snippet?.liveChatId || liveStreamingDetails?.activeLiveChatId || null,
			concurrentViewers: Number(liveStreamingDetails?.concurrentViewers ?? 0),
			lifetimeViews: Number(videoStats?.viewCount ?? 0),
			likes: Number(videoStats?.likeCount ?? 0),
			comments: Number(videoStats?.commentCount ?? 0),
			thumbnail:
				videoSnippet?.thumbnails?.maxres?.url ||
				videoSnippet?.thumbnails?.standard?.url ||
				videoSnippet?.thumbnails?.high?.url ||
				videoSnippet?.thumbnails?.medium?.url ||
				videoSnippet?.thumbnails?.default?.url ||
				snippet?.thumbnails?.high?.url ||
				snippet?.thumbnails?.medium?.url ||
				snippet?.thumbnails?.default?.url ||
				null
		};
	}

	private parseOptionalDateMs(value?: string | null) {
		if (!value) return null;
		const dateMs = new Date(String(value)).getTime();
		return Number.isFinite(dateMs) ? dateMs : null;
	}

	private chunkValues<T>(values: T[], size: number) {
		if (size <= 0) {
			return [values];
		}
		const chunks: T[][] = [];
		for (let index = 0; index < values.length; index += size) {
			chunks.push(values.slice(index, index + size));
		}
		return chunks;
	}

	private async fetchVideosMap(
		accessToken: string,
		videoIds: string[],
		part = 'snippet,statistics,contentDetails'
	) {
		const uniqueVideoIds = Array.from(new Set(videoIds.filter(Boolean)));
		if (!uniqueVideoIds.length) {
			return {};
		}

		const videoDetailsMap: Record<string, any> = {};
		const chunkSize = 50;

		for (let index = 0; index < uniqueVideoIds.length; index += chunkSize) {
			const chunk = uniqueVideoIds.slice(index, index + chunkSize);
			const videosResponse = await this.timedGet(
				'youtube.videos.list',
				'https://www.googleapis.com/youtube/v3/videos',
				{
					headers: {
						Authorization: `Bearer ${accessToken}`
					},
					params: {
						part,
						id: chunk.join(','),
						maxResults: chunk.length
					}
				}
			);

			for (const item of videosResponse.data?.items || []) {
				videoDetailsMap[item.id] = item;
			}
		}

		return videoDetailsMap;
	}

	private async getVideoRetentionFallback(channelId: string, videoId: string) {
		const token = await this.youtubeAuthService.getAccessToken();
		const videoDetailsMap = await this.fetchVideosMap(
			token.accessToken,
			[videoId],
			'snippet,contentDetails,liveStreamingDetails,status'
		);
		const video = videoDetailsMap[videoId] || null;
		const videoContext = this.buildRetentionVideoContext(channelId, videoId, video);

		if (videoContext.isActiveLiveStream) {
			return this.buildUnavailableRetentionResponse(channelId, videoId, {
				videoContext,
				availabilityStatus: 'live_in_progress',
				message: 'YouTube retention is pending while this live stream is active',
				availabilityMessage:
					'This video is currently live, so retention checkpoints are not ready yet. They can only appear after the stream ends and analytics processing completes.'
			});
		}

		const points = await this.fetchVideoRetentionPoints(
			token.accessToken,
			channelId,
			videoId,
			video
		);
		if (points.length) {
			return {
				statusCode: HttpStatus.OK,
				message: 'YouTube video retention fetched successfully',
				data: {
					channelId,
					videoId,
					capturedAt: new Date(),
					points,
					source: 'youtube-analytics-api',
					availabilityStatus: 'available',
					...videoContext
				}
			};
		}

		return this.buildUnavailableRetentionResponse(channelId, videoId, {
			videoContext,
			availabilityStatus: videoContext.isLiveStream ? 'awaiting_processing' : 'not_available',
			message: videoContext.isLiveStream
				? 'YouTube retention is not ready for this live stream yet'
				: 'YouTube retention is not available for this video yet',
			availabilityMessage: videoContext.isLiveStream
				? 'This live stream is no longer active, but retention checkpoints are still empty. YouTube may still be processing the archive, or this video has not been included in a stored retention snapshot yet.'
				: 'No stored retention snapshot exists for this video yet, and the on-demand YouTube Analytics query returned no retention checkpoints.'
		});
	}

	private async fetchVideoRetentionPoints(
		accessToken: string,
		channelId: string,
		videoId: string,
		video?: any
	) {
		const publishedAtValue = video?.snippet?.publishedAt || null;
		const publishedAt = publishedAtValue ? new Date(publishedAtValue) : null;
		const endDate = this.formatDate(new Date());
		let startDate = endDate;

		if (publishedAt && !Number.isNaN(publishedAt.getTime())) {
			startDate = this.formatDate(publishedAt);
		}

		if (startDate > endDate) {
			startDate = endDate;
		}

		const response = await this.timedGet(
			'youtubeanalytics.reports.video-retention.on-demand',
			'https://youtubeanalytics.googleapis.com/v2/reports',
			{
				headers: {
					Authorization: `Bearer ${accessToken}`
				},
				params: {
					ids: 'channel==MINE',
					startDate,
					endDate,
					dimensions: 'elapsedVideoTimeRatio',
					metrics: 'audienceWatchRatio,relativeRetentionPerformance',
					filters: `video==${videoId}`,
					sort: 'elapsedVideoTimeRatio'
				}
			}
		);

		return (response.data?.rows || []).map((row: any[]) => ({
			id: null,
			channelId,
			videoId,
			elapsedVideoTimeRatio: String(row[0] ?? '0'),
			audienceWatchRatio: String(row[1] ?? '0'),
			relativeRetentionPerformance: row[2] != null ? String(row[2]) : null,
			audienceType: null,
			capturedAt: new Date(),
			createdAt: null,
			updatedAt: null
		}));
	}

	private buildRetentionVideoContext(channelId: string, videoId: string, video?: any) {
		const snippet = video?.snippet || {};
		const liveStreamingDetails = video?.liveStreamingDetails || {};
		const broadcastState = String(snippet?.liveBroadcastContent || '').toLowerCase();
		const actualStartTime = liveStreamingDetails?.actualStartTime || null;
		const actualEndTime = liveStreamingDetails?.actualEndTime || null;
		const scheduledStartTime = liveStreamingDetails?.scheduledStartTime || null;
		const isLiveStream =
			broadcastState === 'live'
			|| broadcastState === 'upcoming'
			|| !!scheduledStartTime
			|| !!actualStartTime
			|| !!actualEndTime;
		const isActiveLiveStream =
			broadcastState === 'live' || (isLiveStream && !!actualStartTime && !actualEndTime);

		return {
			channelId,
			videoId,
			title: String(snippet?.title || ''),
			publishedAt: snippet?.publishedAt || null,
			liveBroadcastContent: snippet?.liveBroadcastContent || null,
			actualStartTime,
			actualEndTime,
			scheduledStartTime,
			isLiveStream,
			isActiveLiveStream
		};
	}

	private buildUnavailableRetentionResponse(
		channelId: string,
		videoId: string,
		options: {
			videoContext?: Record<string, any>;
			availabilityStatus: string;
			message: string;
			availabilityMessage: string;
		}
	) {
		return {
			statusCode: HttpStatus.OK,
			message: options.message,
			data: {
				channelId,
				videoId,
				capturedAt: null,
				points: [],
				source: 'unavailable',
				availabilityStatus: options.availabilityStatus,
				availabilityMessage: options.availabilityMessage,
				...(options.videoContext || {})
			}
		};
	}

	private buildLiveViewerSamplePayload(currentLive: any, sampledAt = new Date()) {
		return {
			channelId: String(currentLive?.channelId || ''),
			videoId: String(currentLive?.videoId || ''),
			title: currentLive?.title || null,
			concurrentViewers: String(currentLive?.concurrentViewers ?? 0),
			lifeTimeViews:
				currentLive?.lifeTimeViews != null ? String(currentLive.lifeTimeViews) : null,
			likes: currentLive?.likes != null ? String(currentLive.likes) : null,
			comments: currentLive?.comments != null ? String(currentLive.comments) : null,
			liveBroadcastContent: currentLive?.liveBroadcastContent || null,
			broadcastStatus: currentLive?.broadcastStatus || null,
			actualStartTime: currentLive?.actualStartTime || null,
			actualEndTime: currentLive?.actualEndTime || null,
			sampledAt
		};
	}

	private normalizeLiveViewerTimelinePoint(row: any) {
		return {
			id: row?.id ?? null,
			channelId: String(row?.channelId || ''),
			videoId: String(row?.videoId || ''),
			title: row?.title || null,
			concurrentViewers: Number(row?.concurrentViewers ?? 0),
			lifeTimeViews: Number(row?.lifeTimeViews ?? 0),
			likes: Number(row?.likes ?? 0),
			comments: Number(row?.comments ?? 0),
			liveBroadcastContent: row?.liveBroadcastContent || null,
			broadcastStatus: row?.broadcastStatus || null,
			actualStartTime: row?.actualStartTime || null,
			actualEndTime: row?.actualEndTime || null,
			sampledAt: row?.sampledAt || null,
			createdAt: row?.createdAt || null,
			updatedAt: row?.updatedAt || null
		};
	}

	private buildLiveViewerTimelineSummary(points: any[]) {
		if (!points.length) {
			return {
				samplesCount: 0,
				peakConcurrentViewers: 0,
				peakSampledAt: null,
				lowestConcurrentViewers: 0,
				lowestSampledAt: null,
				averageConcurrentViewers: 0,
				latestConcurrentViewers: 0,
				firstSampledAt: null,
				lastSampledAt: null
			};
		}

		const sorted = [...points].sort((a, b) =>
			String(a?.sampledAt || '').localeCompare(String(b?.sampledAt || ''))
		);
		const peakPoint = sorted.reduce((best: any, point: any) =>
			Number(point?.concurrentViewers || 0) > Number(best?.concurrentViewers || 0)
				? point
				: best
		);
		const lowestPoint = sorted.reduce((best: any, point: any) =>
			Number(point?.concurrentViewers || 0) < Number(best?.concurrentViewers || 0)
				? point
				: best
		);
		const totalConcurrentViewers = sorted.reduce(
			(sum: number, point: any) => sum + Number(point?.concurrentViewers || 0),
			0
		);
		const latestPoint = sorted[sorted.length - 1];

		return {
			samplesCount: sorted.length,
			peakConcurrentViewers: Number(peakPoint?.concurrentViewers || 0),
			peakSampledAt: peakPoint?.sampledAt || null,
			lowestConcurrentViewers: Number(lowestPoint?.concurrentViewers || 0),
			lowestSampledAt: lowestPoint?.sampledAt || null,
			averageConcurrentViewers: sorted.length
				? Number((totalConcurrentViewers / sorted.length).toFixed(2))
				: 0,
			latestConcurrentViewers: Number(latestPoint?.concurrentViewers || 0),
			firstSampledAt: sorted[0]?.sampledAt || null,
			lastSampledAt: latestPoint?.sampledAt || null
		};
	}

	private resolveVideoAnalyticsRange(video: any, startDate?: string, endDate?: string) {
		if (startDate && endDate) {
			return { startDate, endDate };
		}

		const snippet = video?.snippet || {};
		const liveStreamingDetails = video?.liveStreamingDetails || {};
		const startCandidate =
			liveStreamingDetails?.actualStartTime
			|| liveStreamingDetails?.scheduledStartTime
			|| snippet?.publishedAt
			|| null;
		const parsedStart = startCandidate ? new Date(startCandidate) : null;
		const end = new Date();
		const safeStart =
			parsedStart && !Number.isNaN(parsedStart.getTime()) ? parsedStart : new Date(end);

		return {
			startDate: this.formatDate(safeStart),
			endDate: this.formatDate(end)
		};
	}

	private buildGeoCountryVideoRows(
		channelId: string,
		range: { startDate: string; endDate: string },
		rows: Array<{
			videoId: string;
			views: number;
			estimatedMinutesWatched: number;
		}>,
		videoDetailsMap: Record<string, any>,
		sortBy: string,
		order: 'asc' | 'desc'
	) {
		const totalViews = rows.reduce((sum, row) => sum + Number(row.views ?? 0), 0);
		const totalEstimatedMinutesWatched = rows.reduce(
			(sum, row) => sum + Number(row.estimatedMinutesWatched ?? 0),
			0
		);
		const totalDays = this.getInclusiveDateCount(range.startDate, range.endDate);

		const tableRows = rows
			.map((row) => {
				const video = videoDetailsMap[row.videoId] || null;
				const snippet = video?.snippet || {};
				const statistics = video?.statistics || {};
				const contentDetails = video?.contentDetails || {};
				const durationSeconds = this.parseIso8601DurationToSeconds(
					contentDetails?.duration
				);
				const averageViewDurationSeconds = this.calculateAverageViewDurationSeconds(
					row.estimatedMinutesWatched,
					row.views
				);
				const lifetimeViews = Number(statistics?.viewCount ?? 0);
				const lifetimeLikes = Number(statistics?.likeCount ?? 0);
				const lifetimeComments = Number(statistics?.commentCount ?? 0);

				return {
					channelId,
					videoId: row.videoId,
					views: Number(row.views ?? 0),
					estimatedMinutesWatched: Number(row.estimatedMinutesWatched ?? 0),
					watchTimeHours: Number(row.estimatedMinutesWatched ?? 0) / 60,
					averageViewDurationSeconds,
					averageViewDurationLabel: this.formatDurationFromSeconds(
						averageViewDurationSeconds
					),
					countryViewsSharePercent: totalViews
						? Number((((Number(row.views ?? 0) / totalViews) * 100)).toFixed(2))
						: 0,
					countryWatchTimeSharePercent: totalEstimatedMinutesWatched
						? Number(
							((((Number(row.estimatedMinutesWatched ?? 0) /
								totalEstimatedMinutesWatched) *
								100))).toFixed(2)
						)
						: 0,
					viewsPerDay: totalDays
						? Number((Number(row.views ?? 0) / totalDays).toFixed(2))
						: Number(row.views ?? 0),
					title: String(snippet?.title || ''),
					channelTitle: String(snippet?.channelTitle || ''),
					publishedAt: snippet?.publishedAt || null,
					publishedDaysAgo: this.getPublishedDaysAgo(snippet?.publishedAt),
					thumbnail:
						snippet?.thumbnails?.medium?.url ||
						snippet?.thumbnails?.high?.url ||
						snippet?.thumbnails?.default?.url ||
						null,
					tags: Array.isArray(snippet?.tags) ? snippet.tags : [],
					duration: contentDetails?.duration || null,
					durationSeconds,
					formatType: this.resolveVideoFormatType(video),
					isShort: durationSeconds > 0 && durationSeconds <= 60,
					isLive:
						String(snippet?.liveBroadcastContent || '').toLowerCase() === 'live',
					lifetimeViews,
					lifetimeLikes,
					lifetimeComments,
					lifetimeEngagementRatePercent: lifetimeViews
						? Number((((lifetimeLikes + lifetimeComments) / lifetimeViews) * 100).toFixed(2))
						: 0,
					video
				};
			})
			.sort((a, b) => {
				const aValue = this.resolveSortableValue(a, sortBy);
				const bValue = this.resolveSortableValue(b, sortBy);
				if (aValue === bValue) return 0;
				if (order === 'asc') return aValue > bValue ? 1 : -1;
				return aValue < bValue ? 1 : -1;
			})
			.map((row, index) => ({
				...row,
				rank: index + 1
			}));

		return tableRows;
	}

	private normalizeTopVideoAnalyticsRow(row: any) {
		const video = row?.video || {};
		const snippet = video?.snippet || {};
		const statistics = video?.statistics || {};
		const analytics = row?.analytics || {};
		const estimatedMinutesWatched = Number(analytics?.estimatedMinutesWatched ?? 0);
		const views = Number(analytics?.views ?? 0);
		const averageViewDurationSeconds =
			Number(analytics?.averageViewDuration ?? 0) ||
			this.calculateAverageViewDurationSeconds(estimatedMinutesWatched, views);
		const durationSeconds = this.parseIso8601DurationToSeconds(
			video?.contentDetails?.duration
		);

		return {
			channelId: String(snippet?.channelId || ''),
			videoId: String(row?.videoId || ''),
			title: String(snippet?.title || ''),
			channelTitle: String(snippet?.channelTitle || ''),
			publishedAt: snippet?.publishedAt || null,
			thumbnail:
				snippet?.thumbnails?.medium?.url ||
				snippet?.thumbnails?.high?.url ||
				snippet?.thumbnails?.default?.url ||
				null,
			tags: Array.isArray(snippet?.tags) ? snippet.tags : [],
			duration: video?.contentDetails?.duration || null,
			durationSeconds,
			formatType: this.resolveVideoFormatType(video),
			isShort: durationSeconds > 0 && durationSeconds <= 60,
			views,
			estimatedMinutesWatched,
			watchTimeHours: estimatedMinutesWatched / 60,
			subscribersGained: Number(analytics?.subscribersGained ?? 0),
			likes: Number(analytics?.likes ?? 0),
			comments: Number(analytics?.comments ?? 0),
			averageViewDurationSeconds,
			averageViewDurationLabel: this.formatDurationFromSeconds(
				averageViewDurationSeconds
			),
			lifetimeViews: Number(statistics?.viewCount ?? 0),
			lifetimeLikes: Number(statistics?.likeCount ?? 0),
			lifetimeComments: Number(statistics?.commentCount ?? 0),
			video
		};
	}

	private buildOverallTagRows(
		rows: any[],
		sortBy: string,
		order: 'asc' | 'desc'
	) {
		const tagMap = new Map<string, any>();

		for (const row of rows) {
			for (const originalTag of Array.isArray(row?.tags) ? row.tags : []) {
				const normalizedTag = this.normalizeTag(originalTag);
				if (!normalizedTag) continue;

				const existing = tagMap.get(normalizedTag) || {
					tag: String(originalTag).trim(),
					normalizedTag,
					videoCount: 0,
					views: 0,
					estimatedMinutesWatched: 0,
					watchTimeHours: 0,
					subscribersGained: 0,
					likes: 0,
					comments: 0,
					topVideos: []
				};

				existing.videoCount += 1;
				existing.views += Number(row?.views ?? 0);
				existing.estimatedMinutesWatched += Number(row?.estimatedMinutesWatched ?? 0);
				existing.watchTimeHours += Number(row?.watchTimeHours ?? 0);
				existing.subscribersGained += Number(row?.subscribersGained ?? 0);
				existing.likes += Number(row?.likes ?? 0);
				existing.comments += Number(row?.comments ?? 0);
				existing.topVideos.push({
					videoId: row?.videoId,
					title: row?.title,
					thumbnail: row?.thumbnail,
					views: Number(row?.views ?? 0),
					watchTimeHours: Number(row?.watchTimeHours ?? 0)
				});
				tagMap.set(normalizedTag, existing);
			}
		}

		return Array.from(tagMap.values())
			.map((row) => ({
				...row,
				averageViewDurationSeconds: this.calculateAverageViewDurationSeconds(
					row.estimatedMinutesWatched,
					row.views
				),
				averageViewDurationLabel: this.formatDurationFromSeconds(
					this.calculateAverageViewDurationSeconds(
						row.estimatedMinutesWatched,
						row.views
					)
				),
				topVideos: row.topVideos
					.sort((a: any, b: any) => Number(b.views ?? 0) - Number(a.views ?? 0))
					.slice(0, 3)
			}))
			.sort((a, b) => this.sortRowsByKey(a, b, sortBy, order))
			.map((row, index) => ({
				...row,
				rank: index + 1
			}));
	}

	private buildCountryTagRows(
		rows: any[],
		sortBy: string,
		order: 'asc' | 'desc'
	) {
		const tagMap = new Map<string, any>();
		const totalViews = rows.reduce((sum, row) => sum + Number(row?.views ?? 0), 0);

		for (const row of rows) {
			for (const originalTag of Array.isArray(row?.tags) ? row.tags : []) {
				const normalizedTag = this.normalizeTag(originalTag);
				if (!normalizedTag) continue;

				const existing = tagMap.get(normalizedTag) || {
					tag: String(originalTag).trim(),
					normalizedTag,
					videoCount: 0,
					views: 0,
					estimatedMinutesWatched: 0,
					watchTimeHours: 0,
					topVideos: []
				};

				existing.videoCount += 1;
				existing.views += Number(row?.views ?? 0);
				existing.estimatedMinutesWatched += Number(row?.estimatedMinutesWatched ?? 0);
				existing.watchTimeHours += Number(row?.watchTimeHours ?? 0);
				existing.topVideos.push({
					videoId: row?.videoId,
					title: row?.title,
					thumbnail: row?.thumbnail,
					views: Number(row?.views ?? 0),
					watchTimeHours: Number(row?.watchTimeHours ?? 0)
				});
				tagMap.set(normalizedTag, existing);
			}
		}

		return Array.from(tagMap.values())
			.map((row) => ({
				...row,
				countryViewsSharePercent: totalViews
					? Number((((row.views / totalViews) * 100)).toFixed(2))
					: 0,
				averageViewDurationSeconds: this.calculateAverageViewDurationSeconds(
					row.estimatedMinutesWatched,
					row.views
				),
				averageViewDurationLabel: this.formatDurationFromSeconds(
					this.calculateAverageViewDurationSeconds(
						row.estimatedMinutesWatched,
						row.views
					)
				),
				topVideos: row.topVideos
					.sort((a: any, b: any) => Number(b.views ?? 0) - Number(a.views ?? 0))
					.slice(0, 3)
			}))
			.sort((a, b) => this.sortRowsByKey(a, b, sortBy, order))
			.map((row, index) => ({
				...row,
				rank: index + 1
			}));
	}

	private buildTagDetailSummary(
		normalizedTag: string,
		rows: any[],
		scope: 'overall' | 'country'
	) {
		const summary = rows.reduce(
			(acc, row) => {
				acc.videoCount += 1;
				acc.views += Number(row?.views ?? 0);
				acc.estimatedMinutesWatched += Number(row?.estimatedMinutesWatched ?? 0);
				acc.watchTimeHours += Number(row?.watchTimeHours ?? 0);
				acc.subscribersGained += Number(row?.subscribersGained ?? 0);
				acc.likes += Number(row?.likes ?? 0);
				acc.comments += Number(row?.comments ?? 0);
				return acc;
			},
			{
				videoCount: 0,
				views: 0,
				estimatedMinutesWatched: 0,
				watchTimeHours: 0,
				subscribersGained: 0,
				likes: 0,
				comments: 0
			}
		);

		const tagLabel = rows.flatMap((row) => Array.isArray(row?.tags) ? row.tags : [])
			.find((tag) => this.normalizeTag(tag) === normalizedTag) || normalizedTag;

		return {
			tag: tagLabel,
			summary: {
				...summary,
				scope,
				averageViewDurationSeconds: this.calculateAverageViewDurationSeconds(
					summary.estimatedMinutesWatched,
					summary.views
				),
				averageViewDurationLabel: this.formatDurationFromSeconds(
					this.calculateAverageViewDurationSeconds(
						summary.estimatedMinutesWatched,
						summary.views
					)
				)
			}
		};
	}

	private async buildTagCountryBreakdown(
		channelId: string,
		videoIds: string[],
		range: { startDate: string; endDate: string }
	) {
		if (!videoIds.length) {
			return [];
		}

		const rows = await this.youtubeVideoGeoStatsRepo.findAll({
			where: {
				channelId,
				videoId: {
					[Op.in]: Array.from(new Set(videoIds))
				},
				date: {
					[Op.between]: [range.startDate, range.endDate]
				}
			},
			raw: true
		});

		const countryMap = new Map<string, { countryCode: string; views: number; estimatedMinutesWatched: number }>();
		for (const row of rows) {
			const countryCode = this.normalizeCountryCode(row.countryCode);
			if (!countryCode) continue;

			const existing = countryMap.get(countryCode) || {
				countryCode,
				views: 0,
				estimatedMinutesWatched: 0
			};
			existing.views += Number(row.views ?? 0);
			existing.estimatedMinutesWatched += Number(row.estimatedMinutesWatched ?? 0);
			countryMap.set(countryCode, existing);
		}

		const locationMap = await this.getCountryLocationMap(Array.from(countryMap.keys()));
		return Array.from(countryMap.values())
			.map((row) => ({
				...row,
				watchTimeHours: Number(row.estimatedMinutesWatched ?? 0) / 60,
				slug: locationMap.get(row.countryCode)?.slug ?? null,
				geoName: locationMap.get(row.countryCode)?.name ?? null,
				lat: locationMap.get(row.countryCode)?.latitude ?? null,
				lng: locationMap.get(row.countryCode)?.longitude ?? null
			}))
			.sort((a, b) => Number(b.views ?? 0) - Number(a.views ?? 0))
			.slice(0, 10);
	}

	private getNormalizedTagsFromRow(row: any) {
		return (Array.isArray(row?.tags) ? row.tags : [])
			.map((tag: string) => this.normalizeTag(tag))
			.filter(Boolean);
	}

	private async getOwnChannelId(accessToken: string) {
		const response = await this.timedGet(
			'youtube.channels.mine-id',
			'https://www.googleapis.com/youtube/v3/channels',
			{
				headers: {
					Authorization: `Bearer ${accessToken}`
				},
				params: {
					part: 'id',
					mine: true,
					maxResults: 1
				}
			}
		);

		const channelId = response.data?.items?.[0]?.id;
		if (!channelId) {
			throw new NotFoundException('Unable to determine YouTube channel id');
		}
		return String(channelId);
	}

	private resolvePagination(
		page?: number,
		limit?: number,
		defaultLimit = 10,
		maxLimit = 100
	) {
		const hasPage = Number.isFinite(page) && Number(page) > 0;
		const hasLimit = Number.isFinite(limit) && Number(limit) > 0;
		const shouldPaginate = hasPage || hasLimit;
		const safePage = hasPage ? Number(page) : 1;
		const safeLimitRaw = hasLimit ? Number(limit) : defaultLimit;
		const safeLimit = Math.min(safeLimitRaw, maxLimit);
		const offset = (safePage - 1) * safeLimit;

		return {
			shouldPaginate,
			page: safePage,
			limit: safeLimit,
			offset
		};
	}

	private applyPaginationToRowsResponse(
		result: any,
		page?: number,
		limit?: number,
		defaultLimit = 10,
		maxLimit = 100
	) {
		const rows = result?.data?.rows || [];
		const pagination = this.resolvePagination(page, limit, defaultLimit, maxLimit);

		if (!pagination.shouldPaginate) {
			return result;
		}

		const pagedRows = rows.slice(pagination.offset, pagination.offset + pagination.limit);
		return {
			...result,
			data: {
				...result.data,
				rows: pagedRows
			},
			pagination: {
				page: pagination.page,
				limit: pagination.limit,
				total: rows.length,
				totalPages: Math.ceil(rows.length / pagination.limit)
			}
		};
	}

	private resolveDashboardSortBy(sortBy?: string) {
		const allowed = new Set([
			'views',
			'watchTimeHours',
			'subscribersGained',
			'likes',
			'comments',
			'averageViewDurationSeconds',
			'publishedAt',
			'title',
			'lifetimeViews'
		]);
		return allowed.has(String(sortBy || '')) ? String(sortBy) : 'views';
	}

	private resolveGeoVideoSortBy(sortBy?: string) {
		const allowed = new Set(['views', 'estimatedMinutesWatched', 'watchTimeHours']);
		return allowed.has(String(sortBy || '')) ? String(sortBy) : 'views';
	}

	private resolveSortableValue(row: Record<string, any>, sortBy: string) {
		const value = row[sortBy];
		if (value == null) return 0;
		if (sortBy === 'title' || sortBy === 'publishedAt') {
			return String(value).toLowerCase();
		}
		return Number(value) || 0;
	}

	private resolveGeoMetric(metric?: string) {
		const allowed = new Set(['views', 'estimatedMinutesWatched', 'watchTimeHours']);
		return allowed.has(String(metric || '')) ? String(metric) : 'views';
	}

	private resolveTagSortBy(sortBy?: string) {
		const allowed = new Set([
			'views',
			'watchTimeHours',
			'videoCount',
			'subscribersGained',
			'likes',
			'comments',
			'averageViewDurationSeconds'
		]);
		return allowed.has(String(sortBy || '')) ? String(sortBy) : 'views';
	}

	private resolveCountryTagSortBy(sortBy?: string) {
		const allowed = new Set([
			'views',
			'watchTimeHours',
			'videoCount',
			'averageViewDurationSeconds',
			'countryViewsSharePercent'
		]);
		return allowed.has(String(sortBy || '')) ? String(sortBy) : 'views';
	}

	private resolveMetricValue(
		row: { views: number; estimatedMinutesWatched: number; watchTimeHours?: number },
		metric: string
	) {
		if (metric === 'watchTimeHours') {
			return Number(row.watchTimeHours ?? Number(row.estimatedMinutesWatched ?? 0) / 60);
		}
		return Number((row as any)[metric] ?? 0);
	}

	private resolveTopN(topN?: number, defaultValue = 10, maxValue = 50) {
		if (!Number.isFinite(topN) || Number(topN) <= 0) {
			return defaultValue;
		}
		return Math.min(Number(topN), maxValue);
	}

	private calculateAverageViewDurationSeconds(
		estimatedMinutesWatched?: number,
		views?: number
	) {
		const safeViews = Number(views ?? 0);
		if (!safeViews) return 0;
		return Number((((Number(estimatedMinutesWatched ?? 0) * 60) / safeViews)).toFixed(2));
	}

	private formatDurationFromSeconds(totalSeconds?: number) {
		const seconds = Math.max(0, Math.round(Number(totalSeconds ?? 0)));
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = seconds % 60;
		return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
	}

	private parseIso8601DurationToSeconds(duration?: string) {
		if (!duration) return 0;
		const match = String(duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
		if (!match) return 0;
		const hours = Number(match[1] || 0);
		const minutes = Number(match[2] || 0);
		const seconds = Number(match[3] || 0);
		return hours * 3600 + minutes * 60 + seconds;
	}

	private resolveVideoFormatType(video: any) {
		const liveState = String(video?.snippet?.liveBroadcastContent || '').toLowerCase();
		if (liveState === 'live' || liveState === 'upcoming') {
			return 'live';
		}

		const durationSeconds = this.parseIso8601DurationToSeconds(
			video?.contentDetails?.duration
		);
		if (durationSeconds > 0 && durationSeconds <= 60) {
			return 'short';
		}

		return 'video';
	}

	private getInclusiveDateCount(startDate: string, endDate: string) {
		const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
		const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
		if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
			return 1;
		}

		return Math.floor((end - start) / 86_400_000) + 1;
	}

	private getPublishedDaysAgo(publishedAt?: string) {
		if (!publishedAt) return null;
		const publishedAtMs = new Date(publishedAt).getTime();
		if (!Number.isFinite(publishedAtMs)) return null;
		return Math.max(0, Math.floor((Date.now() - publishedAtMs) / 86_400_000));
	}

	private sortRowsByKey(a: Record<string, any>, b: Record<string, any>, key: string, order: 'asc' | 'desc') {
		const aValue = this.resolveSortableValue(a, key);
		const bValue = this.resolveSortableValue(b, key);
		if (aValue === bValue) return 0;
		if (order === 'asc') return aValue > bValue ? 1 : -1;
		return aValue < bValue ? 1 : -1;
	}

	private getErrorMessage(err: any) {
		if (err?.code === 'ECONNABORTED') {
			return `Upstream request timed out after ${this.requestTimeoutMs}ms`;
		}
		const googleMessage =
			err?.response?.data?.error?.message || err?.response?.data?.error_description;
		const googleReason = err?.response?.data?.error?.errors
			?.map((entry: any) => entry?.reason)
			?.filter(Boolean)
			?.join(', ');
		if (googleMessage && googleReason) {
			return `${googleMessage} (reason: ${googleReason})`;
		}
		if (googleMessage) return googleMessage;
		return err?.message || 'Unknown upstream error';
	}

	private readonly hotTierReserveUnits = Number(process.env.YOUTUBE_HOT_TIER_RESERVE_UNITS ?? 500);

	/** True once the remaining daily budget for the given quota pool (minus a reserve
	 * earmarked for hot-tier work) is low enough that warm/cool tier (older, already
	 * fairly-stable) videos should back off for this run so newly published videos always
	 * get processed. Pass the pool the *gated call itself* bills to — video-retention and
	 * video-geo both call `youtubeanalytics.reports.*`, which bills to 'youtube_analytics',
	 * not the Data v3 pool. */
	private async shouldThrottleLowerPriorityYoutubeWork(pool: YoutubeQuotaPool = 'youtube_analytics') {
		const remaining = await this.youtubeQuotaService.getRemainingBudget(pool);
		return remaining <= this.hotTierReserveUnits;
	}

	private async getLatestCapturedAtByVideoId(videoIds: string[]) {
		const uniqueIds = Array.from(new Set(videoIds.filter(Boolean)));
		if (!uniqueIds.length) {
			return new Map<string, Date>();
		}

		const rows = await this.youtubeVideoRetentionRepo.findAll({
			where: { videoId: { [Op.in]: uniqueIds } },
			attributes: ['videoId', 'capturedAt'],
			order: [['capturedAt', 'DESC']],
			raw: true
		});

		const map = new Map<string, Date>();
		for (const row of rows as any[]) {
			if (!map.has(row.videoId)) {
				map.set(row.videoId, row.capturedAt);
			}
		}
		return map;
	}

	private async getExistingVideoGeoVideoIds(channelId: string, date: string, videoIds: string[]) {
		const uniqueIds = Array.from(new Set(videoIds.filter(Boolean)));
		if (!uniqueIds.length) {
			return new Set<string>();
		}

		const rows = await this.youtubeVideoGeoStatsRepo.findAll({
			where: { channelId, date, videoId: { [Op.in]: uniqueIds } },
			attributes: ['videoId'],
			group: ['videoId'],
			raw: true
		});
		return new Set((rows as any[]).map((row) => row.videoId));
	}

	private getAnalyticsScopeHint(err: any) {
		const reason = JSON.stringify(err?.response?.data || '').toLowerCase();
		if (reason.includes('insufficient') || reason.includes('permission')) {
			return ' Required scope for analytics endpoints: https://www.googleapis.com/auth/yt-analytics.readonly. Re-consent and update refresh token.';
		}
		return '';
	}

	private getAnalyticsAccessHint(err: any) {
		const reason = JSON.stringify(err?.response?.data || '').toLowerCase();
		if (reason.includes('unauthorized') || reason.includes('forbidden')) {
			return ' Verify the Google account behind the refresh token is the owner or manager of the target YouTube channel in YouTube Studio, because analytics calls here use ids=channel==MINE.';
		}
		return '';
	}

	private resolveDateRange(startDate?: string, endDate?: string, defaultDays = 30) {
		if (startDate && endDate) {
			return { startDate, endDate };
		}

		const end = new Date();
		const start = new Date();
		start.setDate(end.getDate() - defaultDays);
		return {
			startDate: this.formatDate(start),
			endDate: this.formatDate(end)
		};
	}

	private formatDate(date: Date) {
		return date.toISOString().slice(0, 10);
	}

	/**
	 * Same reporting-lag problem getDefaultAnalyticsIngestionDates exists for (YouTube
	 * Analytics finalises a day's data 48-72h after it ends), but for a plain start/end
	 * range instead of a list of dates: an explicit range is trusted as-is, but the default
	 * window's end date is backed off latencyDays so it doesn't ask for data that isn't
	 * final yet and silently get zero rows back.
	 */
	private resolveReportingSafeDateRange(
		startDate?: string,
		endDate?: string,
		defaultDays = 7,
		latencyDays = 2
	) {
		if (startDate && endDate) {
			return { startDate, endDate };
		}

		const end = new Date();
		end.setUTCDate(end.getUTCDate() - latencyDays);
		const start = new Date(end);
		start.setUTCDate(start.getUTCDate() - defaultDays);
		return {
			startDate: this.formatDate(start),
			endDate: this.formatDate(end)
		};
	}

	/**
	 * YouTube Analytics finalises a day's per-dimension breakdowns roughly 48–72 h after
	 * it ends, so a nightly job that asks for "yesterday" gets an empty answer every time —
	 * which is exactly how YoutubeGeoDeviceStats sat frozen on 2026-07-13 for two months of
	 * "completed" runs. Default to a short trailing window that ends two days back: the
	 * oldest day in it is reliably final, and because every row is upserted, a day that was
	 * still partial when first seen is corrected on the next night's pass.
	 */
	private getDefaultAnalyticsIngestionDates(windowDays = 3, latencyDays = 2) {
		const dates: string[] = [];
		for (let offset = latencyDays + windowDays - 1; offset >= latencyDays; offset -= 1) {
			const d = new Date();
			d.setUTCDate(d.getUTCDate() - offset);
			dates.push(this.formatDate(d));
		}
		return dates;
	}

	private resolveGeoDeviceIngestionDates(
		targetDate?: string,
		startDate?: string,
		endDate?: string
	) {
		if (startDate || endDate) {
			if (!startDate || !endDate) {
				throw new BadRequestException(
					'Both startDate and endDate are required when using date range ingestion'
				);
			}

			const start = this.parseDateOnlyString(startDate, 'startDate');
			const end = this.parseDateOnlyString(endDate, 'endDate');

			if (start.getTime() > end.getTime()) {
				throw new BadRequestException('startDate must be less than or equal to endDate');
			}

			const dates: string[] = [];
			const cursor = new Date(start);
			while (cursor.getTime() <= end.getTime()) {
				dates.push(this.formatDate(cursor));
				cursor.setUTCDate(cursor.getUTCDate() + 1);
			}

			if (dates.length > 366) {
				throw new BadRequestException('Date range cannot exceed 366 days');
			}
			return dates;
		}

		if (targetDate) {
			this.parseDateOnlyString(targetDate, 'date');
			return [targetDate];
		}

		return this.getDefaultAnalyticsIngestionDates();
	}

	private parseDateOnlyString(dateValue: string, fieldName: string) {
		const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
		if (!dateRegex.test(dateValue)) {
			throw new BadRequestException(`${fieldName} must be in YYYY-MM-DD format`);
		}

		const parsed = new Date(`${dateValue}T00:00:00.000Z`);
		if (Number.isNaN(parsed.getTime()) || this.formatDate(parsed) !== dateValue) {
			throw new BadRequestException(`${fieldName} is not a valid calendar date`);
		}

		return parsed;
	}

	private getUtcDayStart(date: Date) {
		return new Date(
			Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0)
		);
	}

	private getFromCache(key: string) {
		const entry = this.responseCache.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= Date.now()) {
			this.responseCache.delete(key);
			return null;
		}
		return entry.value;
	}

	private setCache(key: string, value: any, ttlMs: number) {
		this.responseCache.set(key, {
			value,
			expiresAt: Date.now() + ttlMs
		});
	}

	private invalidateCache(prefixes: string[]) {
		for (const key of this.responseCache.keys()) {
			if (prefixes.some((prefix) => key.startsWith(prefix))) {
				this.responseCache.delete(key);
			}
		}
	}

	/**
	 * Durable side-channel for the channel-aggregate analytics reports (timeseries, traffic
	 * sources, top videos, demographics, impressions/CTR) that don't have a normalized table
	 * of their own the way retention/geo-device data does. Called right where the live-fetch
	 * methods already cache their result, so persisted history accumulates on every fetch
	 * (dashboard-triggered or the daily `analytics_snapshot` cron) without changing the read path.
	 */
	private async persistAnalyticsSnapshot(
		reportType: string,
		range: { startDate: string; endDate: string } | null,
		data: unknown
	) {
		const snapshotDate = new Date().toISOString().slice(0, 10);
		const rangeStartDate = range?.startDate ?? null;
		const rangeEndDate = range?.endDate ?? null;

		const existing = await this.youtubeAnalyticsSnapshotsRepo.findOne({
			where: {
				reportType,
				snapshotDate,
				rangeStartDate,
				rangeEndDate
			}
		});

		const payload = {
			reportType,
			snapshotDate,
			rangeStartDate,
			rangeEndDate,
			rawJson: JSON.stringify(data ?? null),
			fetchedAt: new Date()
		};

		if (existing) {
			await existing.update(payload);
			return existing;
		}

		return await this.youtubeAnalyticsSnapshotsRepo.create(payload);
	}

	private readonly transientRetryLimit = 2;
	private readonly transientRetryBaseDelayMs = 1000;

	private isTransientServiceError(status: unknown) {
		return status === 503 || status === 502 || status === 504;
	}

	private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`${label} timed out after ${ms}ms`)),
				ms
			);
			promise
				.then((value) => {
					clearTimeout(timer);
					resolve(value);
				})
				.catch((err) => {
					clearTimeout(timer);
					reject(err);
				});
		});
	}

	private delay(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private async timedGet(label: string, url: string, config: any, attempt = 0) {
		const startedAt = Date.now();
		await this.youtubeQuotaService.assertBudgetAvailable(label);
		try {
			const response = await axios.get(url, {
				timeout: this.requestTimeoutMs,
				...config
			});
			await this.youtubeQuotaService.recordUsage(label);
			this.logger.log(
				`${label} succeeded in ${Date.now() - startedAt}ms (status=${response.status})`
			);
			return response;
		} catch (err: any) {
			const status = err?.response?.status ?? 'unknown';
			this.logger.warn(`${label} failed in ${Date.now() - startedAt}ms (status=${status})`);
			if (this.youtubeQuotaService.isQuotaExceededError(err)) {
				this.logger.error(`${label} failed because the YouTube quota budget is exhausted`);
				throw err;
			}

			if (this.isTransientServiceError(status) && attempt < this.transientRetryLimit) {
				const backoffMs = this.transientRetryBaseDelayMs * (attempt + 1);
				this.logger.warn(
					`${label} retrying after transient ${status} error in ${backoffMs}ms (attempt ${attempt + 1}/${this.transientRetryLimit})`
				);
				await this.delay(backoffMs);
				return this.timedGet(label, url, config, attempt + 1);
			}

			const shouldRetry = this.shouldRetryWithFreshToken(err, config);
			if (!shouldRetry) {
				throw err;
			}

			try {
				this.youtubeAuthService.invalidateCachedToken();
				const refreshedToken = await this.youtubeAuthService.getAccessToken({
					forceRefresh: true
				});
				const retryResponse = await axios.get(url, {
					timeout: this.requestTimeoutMs,
					...config,
					headers: {
						...(config?.headers || {}),
						Authorization: `Bearer ${refreshedToken.accessToken}`
					}
				});
				await this.youtubeQuotaService.recordUsage(label);
				this.logger.log(
					`${label} succeeded after token refresh in ${Date.now() - startedAt}ms (status=${retryResponse.status})`
				);
				return retryResponse;
			} catch (retryErr: any) {
				const retryStatus = retryErr?.response?.status ?? 'unknown';
				this.logger.warn(
					`${label} retry after token refresh failed in ${Date.now() - startedAt}ms (status=${retryStatus})`
				);
				throw retryErr;
			}
		}
	}

	private shouldRetryWithFreshToken(err: any, config: any) {
		const status = err?.response?.status;
		const authHeader = config?.headers?.Authorization || config?.headers?.authorization;
		if (status !== 401 || !String(authHeader || '').startsWith('Bearer ')) {
			return false;
		}

		const body = JSON.stringify(err?.response?.data || '').toLowerCase();
		return (
			body.includes('invalid credentials') ||
			body.includes('invalid_grant') ||
			body.includes('expired') ||
			body.includes('revoked') ||
			body.includes('token')
		);
	}
}
