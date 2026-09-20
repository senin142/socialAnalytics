import {
	CityList,
	CountryList,
	MetaAudienceDemographicStats,
	MetaAudienceGeoStats,
	MetaAccountTokens,
	MetaContentMetricSnapshots,
	MetaFacebookPageInsights,
	MetaFacebookPages,
	MetaFacebookPosts,
	MetaFacebookVideoMetrics,
	MetaGeoLocations,
	MetaIngestionRuns,
	MetaInstagramAccountInsights,
	MetaInstagramMedia,
	MetaInstagramMediaInsights,
	MetaInstagramProfiles,
	MetaInstagramStoryStats,
	MetaRateLimitEvents,
	MetaVideoGeoStats
} from '../../../database/entity';
import { logToErrorFile } from '../../../common/logger';
import {
	BadRequestException,
	BadGatewayException,
	ConflictException,
	HttpStatus,
	Inject,
	Injectable,
	Logger,
	NotFoundException,
	OnModuleInit
} from '@nestjs/common';
import { getName as getCountryName } from 'country-list';
import { DataTypes, Op } from 'sequelize';
import { DataCoverageService } from '../../shared/services/data-coverage.service';
import {
	IngestionRunConflictError,
	IngestionRunsService
} from '../../shared/services/ingestion-runs.service';
import {
	classifyContentTier,
	createEmptyTierSummary,
	isRefreshDue,
	TierSummary
} from '../../shared/utils/refresh-tiering';
import { MetaApiService } from './meta-api.service';
import { MetaAuthService } from './meta-auth.service';
import { MetaRateLimitService } from './meta-rate-limit.service';

class MetaContentFailureLimitError extends Error {
	constructor(
		message: string,
		public readonly details: {
			runId: number;
			failureLimit: number;
			failureCount: number;
			failedAssets: Array<{
				platform: 'facebook' | 'instagram';
				assetId: string;
				reasons: string[];
			}>;
		}
	) {
		super(message);
	}
}

@Injectable()
export class MetaIngestService implements OnModuleInit {
	private readonly logger = new Logger(MetaIngestService.name);
	private readonly contentFailureLimit = 10;
	private readonly tierSoftUsageThresholdPercent = Number(
		process.env.META_TIER_SOFT_USAGE_THRESHOLD_PERCENT ?? 70
	);
	/** Whether CityList has rows, checked once per process: an unseeded gazetteer is one
	 * actionable gap, not sixty-one "city not found" rows. */
	private cityListSeeded: boolean | null = null;
	private readonly facebookVideoGeoGapRecordedByPageId = new Set<string>();
	private readonly facebookPostCountsFieldGapRecordedByPageId = new Set<string>();
	private readonly unsupportedFacebookPostMetrics = new Set<string>();
	private readonly unsupportedInstagramMediaMetricsByType = new Map<string, Set<string>>();
	private readonly resolvedFacebookPostMetrics = new Map<
		| 'impressions'
		| 'reach'
		| 'engagement'
		| 'videoViews'
		| 'videoAvgTimeWatched'
		| 'videoCompleteViews30s',
		string
	>();
	private readonly facebookPageInsightMetricConfigs: Array<{
		metricKey: string;
		candidates: string[];
		period: 'day' | 'lifetime';
	}> = [
		// Meta retired page_fans / page_fan_adds / page_fan_removes / page_impressions*
		// from Page Insights; these are the documented successors, each confirmed live
		// against this page on 2026-09-16. page_impressions has no page-level successor.
		{ metricKey: 'page_follows', candidates: ['page_follows', 'page_fans'], period: 'lifetime' },
		{ metricKey: 'page_daily_follows_unique', candidates: ['page_daily_follows_unique', 'page_fan_adds_unique', 'page_fan_adds'], period: 'day' },
		{ metricKey: 'page_daily_unfollows_unique', candidates: ['page_daily_unfollows_unique', 'page_fan_removes_unique', 'page_fan_removes'], period: 'day' },
		{ metricKey: 'page_views_total', candidates: ['page_views_total'], period: 'day' },
		{ metricKey: 'page_post_engagements', candidates: ['page_post_engagements'], period: 'day' },
		{ metricKey: 'page_video_views', candidates: ['page_video_views'], period: 'day' },
		{ metricKey: 'page_video_view_time', candidates: ['page_video_view_time'], period: 'day' },
		{ metricKey: 'page_video_complete_views_30s', candidates: ['page_video_complete_views_30s'], period: 'day' },
		// Value is an object keyed by reaction type ({like, love, wow, haha, sorry, anger});
		// upsertFacebookPageInsightRow stores it as JSON, so nothing else needs to change.
		{ metricKey: 'page_actions_post_reactions_total', candidates: ['page_actions_post_reactions_total'], period: 'day' }
	];
	private readonly facebookPageGeoMetricConfigs: Array<{
		metricKey: string;
		candidates: string[];
		geoType: 'country' | 'city';
	}> = [
		// page_fans_country/page_fans_city were deprecated 2025-11-15 in favor of
		// page_follows_country/page_follows_city (same fallback pattern as page_follows
		// above) — try the new field first, fall back to the old one for accounts still
		// being served it.
		{ metricKey: 'page_fans_country', candidates: ['page_follows_country', 'page_fans_country'], geoType: 'country' },
		{ metricKey: 'page_fans_city', candidates: ['page_follows_city', 'page_fans_city'], geoType: 'city' }
	];

	constructor(
		private readonly metaAuthService: MetaAuthService,
		private readonly metaApiService: MetaApiService,
		private readonly metaRateLimitService: MetaRateLimitService,
		private readonly ingestionRunsService: IngestionRunsService,
		private readonly dataCoverageService: DataCoverageService,
		@Inject('META_AUDIENCE_GEO_STATS_REPOSITORY')
		private readonly metaAudienceGeoStatsRepo: typeof MetaAudienceGeoStats,
		@Inject('META_AUDIENCE_DEMOGRAPHIC_STATS_REPOSITORY')
		private readonly metaAudienceDemographicStatsRepo: typeof MetaAudienceDemographicStats,
		@Inject('META_ACCOUNT_TOKENS_REPOSITORY')
		private readonly metaAccountTokensRepo: typeof MetaAccountTokens,
		@Inject('META_FACEBOOK_PAGES_REPOSITORY')
		private readonly metaFacebookPagesRepo: typeof MetaFacebookPages,
		@Inject('META_FACEBOOK_POSTS_REPOSITORY')
		private readonly metaFacebookPostsRepo: typeof MetaFacebookPosts,
		@Inject('META_FACEBOOK_PAGE_INSIGHTS_REPOSITORY')
		private readonly metaFacebookPageInsightsRepo: typeof MetaFacebookPageInsights,
		@Inject('META_FACEBOOK_VIDEO_METRICS_REPOSITORY')
		private readonly metaFacebookVideoMetricsRepo: typeof MetaFacebookVideoMetrics,
		@Inject('META_CONTENT_METRIC_SNAPSHOTS_REPOSITORY')
		private readonly metaContentMetricSnapshotsRepo: typeof MetaContentMetricSnapshots,
		@Inject('META_INSTAGRAM_PROFILES_REPOSITORY')
		private readonly metaInstagramProfilesRepo: typeof MetaInstagramProfiles,
		@Inject('META_INSTAGRAM_MEDIA_REPOSITORY')
		private readonly metaInstagramMediaRepo: typeof MetaInstagramMedia,
		@Inject('META_INSTAGRAM_ACCOUNT_INSIGHTS_REPOSITORY')
		private readonly metaInstagramAccountInsightsRepo: typeof MetaInstagramAccountInsights,
		@Inject('META_INSTAGRAM_MEDIA_INSIGHTS_REPOSITORY')
		private readonly metaInstagramMediaInsightsRepo: typeof MetaInstagramMediaInsights,
		@Inject('META_INSTAGRAM_STORY_STATS_REPOSITORY')
		private readonly metaInstagramStoryStatsRepo: typeof MetaInstagramStoryStats,
		@Inject('META_VIDEO_GEO_STATS_REPOSITORY')
		private readonly metaVideoGeoStatsRepo: typeof MetaVideoGeoStats,
		@Inject('META_GEO_LOCATIONS_REPOSITORY')
		private readonly metaGeoLocationsRepo: typeof MetaGeoLocations,
		@Inject('META_INGESTION_RUNS_REPOSITORY')
		private readonly metaIngestionRunsRepo: typeof MetaIngestionRuns,
		@Inject('META_RATE_LIMIT_EVENTS_REPOSITORY')
		private readonly metaRateLimitEventsRepo: typeof MetaRateLimitEvents,
		@Inject('COUNTRY_LIST_REPOSITORY')
		private readonly countryListRepo: typeof CountryList,
		@Inject('CITY_LIST_REPOSITORY')
		private readonly cityListRepo: typeof CityList
	) { }

	async onModuleInit() {
		try {
			await this.metaAccountTokensRepo.sync();
			await this.metaFacebookPagesRepo.sync();
			await this.metaFacebookPostsRepo.sync();
			await this.metaFacebookPageInsightsRepo.sync();
			await this.metaFacebookVideoMetricsRepo.sync();
			await this.metaContentMetricSnapshotsRepo.sync();
			await this.metaInstagramProfilesRepo.sync();
			await this.metaInstagramMediaRepo.sync();
			await this.metaInstagramMediaInsightsRepo.sync();
			await this.metaInstagramStoryStatsRepo.sync();
			await this.metaAudienceGeoStatsRepo.sync();
			await this.metaAudienceDemographicStatsRepo.sync();
			await this.metaVideoGeoStatsRepo.sync();
			await this.metaGeoLocationsRepo.sync();
			await this.metaIngestionRunsRepo.sync();
			await this.metaRateLimitEventsRepo.sync();
			await this.cityListRepo.sync();
			await this.metaInstagramAccountInsightsRepo.sync();
			await this.ensureMetaFacebookPostColumns();
			await this.ensureMetaProfileCountColumns();
			await this.ensureMetaInstagramMediaColumns();
			await this.backfillLegacyAudienceGeoRows();
		} catch (err) {
			logToErrorFile(err, 'Error while syncing Meta socialstats tables');
			throw err;
		}
	}

	async getModuleStatus() {
		const latestRun = await this.metaIngestionRunsRepo.findOne({
			order: [['createdAt', 'DESC']],
			raw: true
		});
		const authConfig = this.metaAuthService.getConfigurationStatus().data;
		const [
			pageTokenCount,
			pageCount,
			profileCount,
			facebookPostCount,
			instagramMediaCount,
			contentSnapshotCount,
			audienceGeoRowCount,
			videoGeoRowCount
		] = await Promise.all([
			this.metaAccountTokensRepo.count({
				where: {
					accountType: 'page',
					isExpired: false
				}
			}),
			this.metaFacebookPagesRepo.count(),
			this.metaInstagramProfilesRepo.count(),
			this.metaFacebookPostsRepo.count(),
			this.metaInstagramMediaRepo.count(),
			this.metaContentMetricSnapshotsRepo.count(),
			this.metaAudienceGeoStatsRepo.count(),
			this.metaVideoGeoStatsRepo.count()
		]);
		const stage = this.resolveModuleStage({
			authConfig,
			pageTokenCount,
			pageCount,
			profileCount,
			facebookPostCount,
			instagramMediaCount,
			contentSnapshotCount,
			audienceGeoRowCount,
			latestRun
		});

		return {
			statusCode: HttpStatus.OK,
			message: 'Meta module status fetched successfully',
			data: {
				stage: stage.key,
				stageDescription: stage.description,
				auth: authConfig,
				api: this.metaApiService.getClientMetadata(),
				counts: {
					pageTokens: pageTokenCount,
					facebookPages: pageCount,
					instagramProfiles: profileCount,
					facebookPosts: facebookPostCount,
					instagramMedia: instagramMediaCount,
					contentSnapshots: contentSnapshotCount,
					audienceGeoRows: audienceGeoRowCount,
					videoGeoRows: videoGeoRowCount
				},
				liveBootstrapReady:
					pageTokenCount > 0 || Boolean(authConfig.systemUserTokenConfigured),
				latestRun
			}
		};
	}

	private resolveModuleStage(status: {
		authConfig: Record<string, any>;
		pageTokenCount: number;
		pageCount: number;
		profileCount: number;
		facebookPostCount: number;
		instagramMediaCount: number;
		contentSnapshotCount: number;
		audienceGeoRowCount: number;
		latestRun: any;
	}) {
		if (
			status.facebookPostCount > 0 ||
			status.instagramMediaCount > 0 ||
			status.contentSnapshotCount > 0 ||
			status.audienceGeoRowCount > 0
		) {
			return {
				key: 'data_available',
				description: 'Meta content and/or audience data has already been ingested.'
			};
		}

		if (status.pageCount > 0 || status.profileCount > 0) {
			return {
				key: 'profiles_available',
				description: 'Connected Facebook page and Instagram profile records are stored.'
			};
		}

		if (status.latestRun?.status === 'failed') {
			return {
				key: 'attention_required',
				description: 'The latest Meta ingestion run failed and needs attention.'
			};
		}

		if (
			status.pageTokenCount > 0 ||
			status.authConfig.systemUserTokenConfigured
		) {
			return {
				key: 'bootstrap_ready',
				description: 'Authentication is ready. Run profile/content ingestion to populate dashboard data.'
			};
		}

		if (
			status.authConfig.appIdConfigured &&
			status.authConfig.appSecretConfigured &&
			(status.authConfig.pageIdConfigured ||
				status.authConfig.instagramAccountConfigured)
		) {
			return {
				key: 'auth_configured',
				description: 'Meta app configuration is present, but no page token has been stored yet.'
			};
		}

		return {
			key: 'configuration_required',
			description: 'Meta setup is incomplete for this environment.'
		};
	}

	async getLatestRun() {
		const latestRun = await this.metaIngestionRunsRepo.findOne({
			order: [['createdAt', 'DESC']],
			raw: true
		});

		return {
			statusCode: HttpStatus.OK,
			message: 'Latest Meta ingestion run fetched successfully',
			data: latestRun
		};
	}

	async requestProfileSnapshotRefresh(options?: {
		pageId?: string;
		minFreshMinutes?: number;
		force?: boolean;
	}) {
		const pageId = String(options?.pageId || '').trim() || undefined;
		const minFreshMinutes = Math.max(
			0,
			Number(
				options?.minFreshMinutes ??
				process.env.META_PROFILE_REFRESH_MIN_FRESH_MINUTES ??
				60
			)
		);
		const activeRun = await this.ingestionRunsService.findActiveRun({
			platform: 'meta',
			jobType: 'profile_snapshot',
			entityType: 'page',
			...(pageId ? { entityId: pageId } : {})
		});

		if (activeRun) {
			return {
				statusCode: HttpStatus.ACCEPTED,
				message: 'Meta profile snapshot refresh is already in progress',
				data: {
					enqueued: false,
					reason: 'already_running',
					activeRunId: activeRun.id,
					pageId: pageId ?? null
				}
			};
		}

		if (!options?.force) {
			const latestSuccess = await this.ingestionRunsService.findLatestSuccessfulRun({
				platform: 'meta',
				jobType: 'profile_snapshot',
				entityType: 'page',
				...(pageId ? { entityId: pageId } : {})
			});
			const lastSuccessfulRunAt =
				latestSuccess?.finishedAt || latestSuccess?.startedAt || null;

			if (lastSuccessfulRunAt) {
				const minutesSinceSuccess = Math.max(
					0,
					Math.floor(
						(Date.now() - new Date(lastSuccessfulRunAt).getTime()) / 60_000
					)
				);

				if (minutesSinceSuccess < minFreshMinutes) {
					return {
						statusCode: HttpStatus.OK,
						message: 'Meta profile snapshot is still fresh enough; refresh skipped',
						data: {
							enqueued: false,
							reason: 'fresh_enough',
							pageId: pageId ?? null,
							lastSuccessfulRunAt,
							minFreshMinutes
						}
					};
				}
			}
		}

		void this.ingestProfileSnapshot({
			pageId,
			scope: 'automatic',
			runType: 'incremental',
			triggerSource: 'admin_page_load'
		})
			.catch((error: any) => {
				this.logger.error(
					`Background Meta profile snapshot refresh failed: ${this.getErrorMessage(
						error
					)}`
				);
			});

		return {
			statusCode: HttpStatus.ACCEPTED,
			message: 'Meta profile snapshot refresh started in the background',
			data: {
				enqueued: true,
				pageId: pageId ?? null,
				minFreshMinutes
			}
		};
	}

	async backfillProfileSnapshot(options?: {
		pageId?: string;
		startDate?: string;
		endDate?: string;
	}) {
		const range = this.resolveExplicitDateRange(
			options?.startDate,
			options?.endDate,
			90,
			'Meta profile snapshot backfill'
		);
		return await this.ingestProfileSnapshot({
			pageId: options?.pageId,
			scope: 'historical_backfill',
			runType: 'backfill',
			triggerSource: 'http',
			startDate: range.startDate,
			endDate: range.endDate
		});
	}

	/**
	 * `createRun` is the atomic claim across instances; a conflict means this job is already
	 * running elsewhere. Manual triggers get a 409 they can act on; the scheduler pre-checks
	 * `findActiveRun` so it only lands here on a genuine same-second race.
	 */
	private async claimSharedRun(
		input: Parameters<IngestionRunsService['createRun']>[0]
	) {
		try {
			return await this.ingestionRunsService.createRun(input);
		} catch (error) {
			if (error instanceof IngestionRunConflictError) {
				throw new ConflictException(error.message);
			}
			throw error;
		}
	}

	async queueRun(jobType: string, payload: Record<string, unknown>) {
		const run = await this.metaIngestionRunsRepo.create({
			jobType,
			scope: 'manual',
			status: 'planned',
			startedAt: new Date(),
			finishedAt: null,
			retryCount: 0,
			recordsProcessed: 0,
			lastError: null,
			metadata: JSON.stringify({
				note: 'Scaffolded run. Actual Meta ingestion implementation is the next phase.',
				payload
			})
		});
		const sharedRun = await this.ingestionRunsService.createRun({
			platform: 'meta',
			entityType: 'page',
			entityId: typeof payload.pageId === 'string' ? payload.pageId : 'default',
			jobType,
			runType: 'manual',
			triggerSource: 'http',
			status: 'planned',
			metadata: {
				note: 'Scaffolded run. Actual Meta ingestion implementation is the next phase.',
				payload
			},
			startedAt: run.startedAt
		});

		this.logger.log(`Queued Meta run ${run.id} / shared run ${sharedRun.id} for ${jobType}`);

		return {
			statusCode: HttpStatus.ACCEPTED,
			message: 'Meta ingestion run queued successfully',
			data: run
		};
	}

	private logIngestProgress(jobType: string, runId: number, message: string) {
		this.logger.log(`Meta ingest [${jobType}#${runId}] ${message}`);
	}

	private getErrorMessage(error: any) {
		return (
			error?.response?.data?.error?.message ||
			error?.response?.data?.message ||
			error?.message ||
			'Unknown Meta ingestion error'
		);
	}

	/** True once observed Meta API usage is high enough that warm/cool tier (older,
	 * already-fairly-stable) content should back off for this run so hot/new content always
	 * gets through. Well below the hard cooldown threshold in MetaRateLimitService. */
	private shouldThrottleLowerPriorityWork() {
		const snapshot = this.metaRateLimitService.getUsageSnapshot();
		return (
			snapshot.percent !== null && snapshot.percent >= this.tierSoftUsageThresholdPercent
		);
	}

	private mergeTierSummary(target: TierSummary, source: TierSummary) {
		target.hot += source.hot;
		target.warm += source.warm;
		target.cool += source.cool;
		target.skippedForBudget += source.skippedForBudget;
	}

	private async getLatestFetchedAtByAssetId(platform: 'facebook' | 'instagram', assetIds: string[]) {
		const uniqueIds = Array.from(new Set(assetIds.filter(Boolean)));
		if (!uniqueIds.length) {
			return new Map<string, Date>();
		}

		const rows = await this.metaContentMetricSnapshotsRepo.findAll({
			where: {
				platform,
				assetId: { [Op.in]: uniqueIds }
			},
			attributes: ['assetId', 'fetchedAt'],
			order: [['fetchedAt', 'DESC']],
			raw: true
		});

		const map = new Map<string, Date>();
		for (const row of rows as any[]) {
			if (!map.has(row.assetId)) {
				map.set(row.assetId, row.fetchedAt);
			}
		}
		return map;
	}

	async ingestContentSnapshot(options?: {
		pageId?: string;
		instagramId?: string;
		from?: string;
		to?: string;
		includePosts?: boolean;
		includeMedia?: boolean;
		facebookPostLimit?: number;
		instagramMediaLimit?: number;
		scope?: string;
		runType?: string;
		triggerSource?: string;
	}) {
		const range = this.resolveContentDateRange(options?.from, options?.to, 30);
		const includePosts = options?.includePosts !== false;
		const includeMedia = options?.includeMedia !== false;
		const facebookPostLimit = this.normalizeContentLimit(options?.facebookPostLimit);
		const instagramMediaLimit = this.normalizeContentLimit(options?.instagramMediaLimit);
		// Claim the shared run first: it is the cross-instance guard, and if another
		// instance already holds this job there must be no Meta-local row left "running".
		const sharedRun = await this.claimSharedRun({
			platform: 'meta',
			entityType: 'page',
			entityId: options?.pageId ?? 'default',
			jobType: 'content_snapshot',
			runType: options?.runType ?? 'manual',
			triggerSource: options?.triggerSource ?? 'http',
			status: 'running',
			scopeStartDate: range.startDate,
			scopeEndDate: range.endDate,
				metadata: {
					pageId: options?.pageId ?? null,
					instagramId: options?.instagramId ?? null,
					from: range.startDate,
					to: range.endDate,
					includePosts: options?.includePosts !== false,
					includeMedia: options?.includeMedia !== false,
					facebookPostLimit: options?.facebookPostLimit ?? null,
					instagramMediaLimit: options?.instagramMediaLimit ?? null
				},
				startedAt: new Date()
			});
		const run = await this.metaIngestionRunsRepo.create({
			jobType: 'content_snapshot',
			scope: options?.scope ?? 'manual',
			status: 'running',
			startedAt: sharedRun.startedAt,
			finishedAt: null,
			retryCount: 0,
			recordsProcessed: 0,
			lastError: null,
				metadata: JSON.stringify({
					pageId: options?.pageId ?? null,
					instagramId: options?.instagramId ?? null,
					from: range.startDate,
					to: range.endDate,
					includePosts: options?.includePosts !== false,
					includeMedia: options?.includeMedia !== false,
					facebookPostLimit: options?.facebookPostLimit ?? null,
					instagramMediaLimit: options?.instagramMediaLimit ?? null
				})
			});

		try {
				this.logIngestProgress(
					'content_snapshot',
					run.id,
					`started for pageId=${options?.pageId ?? 'default'} instagramId=${options?.instagramId ?? 'auto'} range=${range.startDate}..${range.endDate} includePosts=${includePosts} includeMedia=${includeMedia} facebookPostLimit=${facebookPostLimit ?? 'none'} instagramMediaLimit=${instagramMediaLimit ?? 'none'}`
				);
			const pageTokenRow = await this.metaAuthService.getEffectivePageToken(options?.pageId);
			this.logIngestProgress(
				'content_snapshot',
				run.id,
				`resolved page token for pageId=${pageTokenRow.pageId} instagramBusinessAccountId=${pageTokenRow.instagramBusinessAccountId ?? 'none'}`
			);
				let recordsProcessed = 0;
			let failureCount = 0;
			const failedAssets: Array<{
				platform: 'facebook' | 'instagram';
				assetId: string;
				reasons: string[];
			}> = [];
			const updateContentProgress = async (progress: {
				platform: 'facebook' | 'instagram';
				assetId: string;
				processed: number;
				total: number;
			}) => {
				recordsProcessed += 1;
				await run.update({
					recordsProcessed,
					metadata: JSON.stringify({
						pageId: options?.pageId ?? null,
						instagramId: options?.instagramId ?? null,
							from: range.startDate,
							to: range.endDate,
							includePosts,
							includeMedia,
							facebookPostLimit,
							instagramMediaLimit,
							failureLimit: this.contentFailureLimit,
							failureCount,
							failedAssets: failedAssets.slice(-10),
						progress: {
							platform: progress.platform,
							assetId: progress.assetId,
							processed: progress.processed,
							total: progress.total
						}
					})
				});
				await this.ingestionRunsService.heartbeatRun(sharedRun.id, {
					entityId: options?.pageId ?? 'default',
					recordsProcessed,
					recordsFetched: recordsProcessed,
					metadata: {
						pageId: options?.pageId ?? null,
						instagramId: options?.instagramId ?? null,
							from: range.startDate,
							to: range.endDate,
							includePosts,
							includeMedia,
							facebookPostLimit,
							instagramMediaLimit,
							failureLimit: this.contentFailureLimit,
							failureCount,
							failedAssets: failedAssets.slice(-10),
						progress: {
							platform: progress.platform,
							assetId: progress.assetId,
							processed: progress.processed,
							total: progress.total
						}
					}
				});
				this.logIngestProgress(
					'content_snapshot',
					run.id,
					`asset progress ${recordsProcessed} total processed; latest ${progress.platform}:${progress.assetId} (${progress.processed}/${progress.total} on current ${progress.platform} batch)`
				);
			};
			const recordContentFailure = async (failure: {
				platform: 'facebook' | 'instagram';
				assetId: string;
				reasons: string[];
			}) => {
				const normalizedReasons = failure.reasons
					.map((reason) => String(reason || '').trim())
					.filter(Boolean);
				if (!normalizedReasons.length) {
					return;
				}

				failureCount += 1;
				failedAssets.push({
					platform: failure.platform,
					assetId: failure.assetId,
					reasons: normalizedReasons
				});
				this.logger.warn(
					`Meta content ingest failure ${failureCount}/${this.contentFailureLimit} for ${failure.platform} asset ${failure.assetId}: ${normalizedReasons.join(' | ')}`
				);
				await run.update({
					lastError: `Latest asset failure: ${failure.platform}:${failure.assetId} - ${normalizedReasons.join(' | ')}`,
					metadata: JSON.stringify({
						pageId: options?.pageId ?? null,
						instagramId: options?.instagramId ?? null,
							from: range.startDate,
							to: range.endDate,
							includePosts,
							includeMedia,
							facebookPostLimit,
							instagramMediaLimit,
							failureLimit: this.contentFailureLimit,
							failureCount,
							failedAssets: failedAssets.slice(-10),
						progress: null
					})
				});
				await this.ingestionRunsService.heartbeatRun(sharedRun.id, {
					errorCode: 'PARTIAL_ASSET_FAILURE',
					errorMessage: `Latest asset failure: ${failure.platform}:${failure.assetId} - ${normalizedReasons.join(' | ')}`,
					recordsProcessed,
					recordsFetched: recordsProcessed,
					metadata: {
						pageId: options?.pageId ?? null,
						instagramId: options?.instagramId ?? null,
							from: range.startDate,
							to: range.endDate,
							includePosts,
							includeMedia,
							facebookPostLimit,
							instagramMediaLimit,
							failureLimit: this.contentFailureLimit,
							failureCount,
							failedAssets: failedAssets.slice(-10),
						progress: null
					}
				});

				if (failureCount > this.contentFailureLimit) {
					throw new MetaContentFailureLimitError(
						`Meta content snapshot stopped after ${failureCount} asset failures`,
						{
							runId: run.id,
							failureLimit: this.contentFailureLimit,
							failureCount,
							failedAssets: failedAssets.slice(-10)
						}
					);
				}
			};
			let postsCreated = 0;
			let postsUpdated = 0;
			let mediaCreated = 0;
			let mediaUpdated = 0;
			const warnings: string[] = [];
			const combinedTierSummary = createEmptyTierSummary();
			// Each source is allowed to fail on its own without sinking the run, but if every
			// source we set out to ingest was skipped the run produced nothing and must not
			// be recorded as a success — freshness would otherwise report content as current
			// while the newest row in the DB keeps ageing.
			let sourcesAttempted = 0;
			let sourcesSkipped = 0;

			if (includePosts) {
				sourcesAttempted++;
				try {
					this.logIngestProgress(
						'content_snapshot',
						run.id,
						`starting Facebook posts ingest for pageId=${pageTokenRow.pageId}`
					);
						const postsResult = await this.ingestFacebookPosts(
							pageTokenRow.accessToken,
							pageTokenRow.pageId,
							range,
							facebookPostLimit,
							updateContentProgress,
							recordContentFailure
						);
					postsCreated = postsResult.created;
					postsUpdated = postsResult.updated;
					this.mergeTierSummary(combinedTierSummary, postsResult.tierSummary);
					this.logIngestProgress(
						'content_snapshot',
						run.id,
						`completed Facebook posts ingest: processed=${postsResult.processed}/${postsResult.total} created=${postsCreated} updated=${postsUpdated}`
					);
				} catch (error: any) {
					if (error instanceof MetaContentFailureLimitError) {
						throw error;
					}
					sourcesSkipped++;
					warnings.push(
						`Facebook posts snapshot skipped: ${
							error?.response?.data?.error?.message ||
							error?.message ||
							'Unknown Facebook posts ingestion error'
						}`
					);
				}
			}

			if (includeMedia) {
				const instagramId = await this.resolveInstagramAccountId(
					pageTokenRow.pageId,
					pageTokenRow.instagramBusinessAccountId ?? null,
					options?.instagramId
				);
				if (instagramId) {
					sourcesAttempted++;
					try {
						this.logIngestProgress(
							'content_snapshot',
							run.id,
							`starting Instagram media ingest for instagramId=${instagramId}`
						);
							const mediaResult = await this.ingestInstagramMedia(
								pageTokenRow.accessToken,
								instagramId,
								range,
								instagramMediaLimit,
								updateContentProgress,
								recordContentFailure
							);
						mediaCreated = mediaResult.created;
						mediaUpdated = mediaResult.updated;
						this.mergeTierSummary(combinedTierSummary, mediaResult.tierSummary);
						this.logIngestProgress(
							'content_snapshot',
							run.id,
							`completed Instagram media ingest: processed=${mediaResult.processed}/${mediaResult.total} created=${mediaCreated} updated=${mediaUpdated}`
						);
					} catch (error: any) {
						if (error instanceof MetaContentFailureLimitError) {
							throw error;
						}
						sourcesSkipped++;
						warnings.push(
							`Instagram media snapshot skipped: ${
								error?.response?.data?.error?.message ||
								error?.message ||
								'Unknown Instagram media ingestion error'
							}`
						);
					}
				} else {
					this.logIngestProgress(
						'content_snapshot',
						run.id,
						'Instagram media ingest skipped because no Instagram account could be resolved'
					);
				}
			}

			if (sourcesAttempted > 0 && sourcesSkipped === sourcesAttempted) {
				throw new Error(
					`Meta content snapshot ingested nothing: every source was skipped (${warnings.join(' | ')})`
				);
			}

				this.logIngestProgress(
					'content_snapshot',
					run.id,
					`finalizing run with recordsProcessed=${recordsProcessed} failures=${failureCount} warnings=${warnings.length}`
				);
				await run.update({
					status: 'completed',
					finishedAt: new Date(),
					recordsProcessed,
					lastError: null,
					metadata: JSON.stringify({
						pageId: options?.pageId ?? null,
						instagramId: options?.instagramId ?? null,
							from: range.startDate,
							to: range.endDate,
							includePosts,
							includeMedia,
							facebookPostLimit,
							instagramMediaLimit,
							failureLimit: this.contentFailureLimit,
							failureCount,
							failedAssets: failedAssets.slice(-10),
						progress: {
							platform: null,
							assetId: null,
							processed: recordsProcessed,
							total: recordsProcessed
						},
						tierSummary: combinedTierSummary
					})
				});
				await this.ingestionRunsService.completeRun(sharedRun.id, {
					entityId: options?.pageId ?? 'default',
					recordsFetched: recordsProcessed,
					recordsProcessed,
					recordsUpserted:
						postsCreated + postsUpdated + mediaCreated + mediaUpdated,
					metadata: {
						pageId: options?.pageId ?? null,
						instagramId: options?.instagramId ?? null,
							from: range.startDate,
							to: range.endDate,
							includePosts,
							includeMedia,
							facebookPostLimit,
							instagramMediaLimit,
							failureLimit: this.contentFailureLimit,
							failureCount,
							failedAssets: failedAssets.slice(-10),
						warnings,
						tierSummary: combinedTierSummary
					}
				});

			return {
				statusCode: HttpStatus.OK,
				message: 'Meta content snapshot ingested successfully',
				data: {
					runId: run.id,
					range,
					pageId: pageTokenRow.pageId,
					instagramId: options?.instagramId ?? pageTokenRow.instagramBusinessAccountId ?? null,
					postsCreated,
					postsUpdated,
					mediaCreated,
					mediaUpdated,
					recordsProcessed,
					warnings
				}
			};
		} catch (error: any) {
			this.logger.error(
				`Meta ingest [content_snapshot#${run.id}] failed: ${
					error?.response?.data?.error?.message ||
					error?.message ||
					'Unknown Meta content ingestion error'
				}`
			);
			if (error instanceof MetaContentFailureLimitError) {
				await run.update({
					status: 'failed',
					finishedAt: new Date(),
					lastError: error.message,
					metadata: JSON.stringify({
						pageId: options?.pageId ?? null,
						instagramId: options?.instagramId ?? null,
							from: range.startDate,
							to: range.endDate,
							includePosts: options?.includePosts !== false,
							includeMedia: options?.includeMedia !== false,
							facebookPostLimit,
							instagramMediaLimit,
							failureLimit: error.details.failureLimit,
							failureCount: error.details.failureCount,
							failedAssets: error.details.failedAssets,
						progress: null
					})
				});
				await this.ingestionRunsService.failRun(sharedRun.id, error, {
					entityId: options?.pageId ?? 'default',
					recordsFetched: error.details.failureCount,
					recordsProcessed: error.details.failureCount,
					metadata: {
						pageId: options?.pageId ?? null,
						instagramId: options?.instagramId ?? null,
							from: range.startDate,
							to: range.endDate,
							includePosts: options?.includePosts !== false,
							includeMedia: options?.includeMedia !== false,
							facebookPostLimit,
							instagramMediaLimit,
							failureLimit: error.details.failureLimit,
							failureCount: error.details.failureCount,
							failedAssets: error.details.failedAssets,
						progress: null
					}
				});
				throw new BadGatewayException({
					statusCode: HttpStatus.BAD_GATEWAY,
					message: error.message,
					data: error.details
				});
			}

			const errorMessage =
				error?.response?.data?.error?.message ||
				error?.message ||
				'Unknown Meta content ingestion error';
			await run.update({
				status: 'failed',
				finishedAt: new Date(),
				lastError: errorMessage
			});
			await this.ingestionRunsService.failRun(sharedRun.id, error, {
				entityId: options?.pageId ?? 'default',
				recordsFetched: 0,
				recordsProcessed: 0
			});
			throw new BadGatewayException(
				`Unable to ingest Meta content snapshot: ${errorMessage}`
			);
		}
	}

	async ingestProfileSnapshot(options?: {
		pageId?: string;
		shortLivedUserToken?: string;
		scope?: string;
		runType?: string;
		triggerSource?: string;
		startDate?: string;
		endDate?: string;
	}) {
		const isHistoricalInsightsBackfill =
			typeof options?.startDate === 'string' || typeof options?.endDate === 'string';
		const historicalRange = isHistoricalInsightsBackfill
			? this.resolveExplicitDateRange(
				options?.startDate,
				options?.endDate,
				90,
				'Meta profile snapshot backfill'
			)
			: null;
		// Claim the shared run first: it is the cross-instance guard, and if another
		// instance already holds this job there must be no Meta-local row left "running".
		const sharedRun = await this.claimSharedRun({
			platform: 'meta',
			entityType: 'page',
			entityId: options?.pageId ?? 'default',
			jobType: 'profile_snapshot',
			runType: options?.runType ?? 'manual',
			triggerSource: options?.triggerSource ?? 'http',
			status: 'running',
			...(historicalRange
				? {
					scopeStartDate: historicalRange.startDate,
					scopeEndDate: historicalRange.endDate
				}
				: {}),
			metadata: {
				pageId: options?.pageId ?? null,
				mode: options?.shortLivedUserToken ? 'bootstrap_and_ingest' : 'ingest_only',
				startDate: historicalRange?.startDate ?? null,
				endDate: historicalRange?.endDate ?? null,
				historicalInsightsBackfill: isHistoricalInsightsBackfill
			},
			startedAt: new Date()
		});
		const run = await this.metaIngestionRunsRepo.create({
			jobType: 'profile_snapshot',
			scope: options?.scope ?? 'manual',
			status: 'running',
			startedAt: sharedRun.startedAt,
			finishedAt: null,
			retryCount: 0,
			recordsProcessed: 0,
			lastError: null,
			metadata: JSON.stringify({
				pageId: options?.pageId ?? null,
				mode: options?.shortLivedUserToken ? 'bootstrap_and_ingest' : 'ingest_only',
				startDate: historicalRange?.startDate ?? null,
				endDate: historicalRange?.endDate ?? null,
				historicalInsightsBackfill: isHistoricalInsightsBackfill
			})
		});

		try {
			this.logIngestProgress(
				'profile_snapshot',
				run.id,
				`started for pageId=${options?.pageId ?? 'default'} mode=${options?.shortLivedUserToken ? 'bootstrap_and_ingest' : 'ingest_only'} historicalInsightsBackfill=${isHistoricalInsightsBackfill}${historicalRange ? ` range=${historicalRange.startDate}..${historicalRange.endDate}` : ''}`
			);
			if (options?.shortLivedUserToken) {
				this.logIngestProgress(
					'profile_snapshot',
					run.id,
					'bootstrapping managed assets from short-lived user token'
				);
				await this.metaAuthService.bootstrapManagedAssets({
					shortLivedUserToken: options.shortLivedUserToken,
					pageId: options.pageId
				});
				this.logIngestProgress(
					'profile_snapshot',
					run.id,
					'bootstrap completed successfully'
				);
			}

			const pageTokenRow = await this.metaAuthService.getEffectivePageToken(
				options?.pageId
			);
			this.logIngestProgress(
				'profile_snapshot',
				run.id,
				`resolved page token for pageId=${pageTokenRow.pageId} instagramBusinessAccountId=${pageTokenRow.instagramBusinessAccountId ?? 'none'}`
			);

			const pageDetails = await this.metaApiService.get<{
				id: string;
				name?: string;
				category?: string;
				fan_count?: number;
				followers_count?: number;
				picture?: { data?: { url?: string } };
				about?: string;
				website?: string;
				link?: string;
				instagram_business_account?: { id: string };
			}>(`/${pageTokenRow.pageId}`, {
				accessToken: pageTokenRow.accessToken,
				params: {
					fields:
						'id,name,category,fan_count,followers_count,picture.type(large),about,website,link,instagram_business_account'
				},
				endpointLabel: 'page_profile_snapshot'
			});
			this.logIngestProgress(
				'profile_snapshot',
				run.id,
				`fetched Facebook page profile for pageId=${pageDetails.id} name=${pageDetails.name ?? 'unknown'}`
			);

			if (!pageDetails?.id) {
				throw new NotFoundException('Meta did not return a Facebook page profile');
			}

			const facebookPostCount = await this.fetchFacebookPagePostCount(
				pageTokenRow.accessToken,
				pageDetails.id
			);
			this.logIngestProgress(
				'profile_snapshot',
				run.id,
				`resolved Facebook post count=${facebookPostCount ?? 'unavailable'} for pageId=${pageDetails.id}`
			);

			const existingPage = await this.metaFacebookPagesRepo.findOne({
				where: { pageId: pageDetails.id }
			});
			const pagePayload = {
				pageId: pageDetails.id,
				name: pageDetails.name ?? null,
				category: pageDetails.category ?? null,
				followers:
					pageDetails.followers_count !== undefined
						? String(pageDetails.followers_count)
						: null,
				fans:
					pageDetails.fan_count !== undefined ? String(pageDetails.fan_count) : null,
				// An unavailable count this run (throttled, or history longer than the walk
				// cap) is not evidence the page has no posts — keep whatever was last stored.
				postCount:
					facebookPostCount !== null
						? String(facebookPostCount)
						: existingPage?.postCount ?? null,
				picture: pageDetails.picture?.data?.url ?? null,
				about: pageDetails.about ?? null,
				website: pageDetails.website ?? null,
				pageLink: pageDetails.link ?? null,
				lastIngestedAt: new Date()
			};

			const pageRecord = existingPage
				? await existingPage.update(pagePayload)
				: await this.metaFacebookPagesRepo.create(pagePayload);
			this.logIngestProgress(
				'profile_snapshot',
				run.id,
				`stored Facebook page snapshot for pageId=${pageDetails.id}`
			);

			let instagramRecord: MetaInstagramProfiles | null = null;
			const warnings: string[] = [];
			if (pageDetails.instagram_business_account?.id) {
				this.logIngestProgress(
					'profile_snapshot',
					run.id,
					`fetching Instagram profile for instagramId=${pageDetails.instagram_business_account.id}`
				);
				const instagramDetails = await this.metaApiService.get<{
					id: string;
					username?: string;
					followers_count?: number;
					follows_count?: number;
					media_count?: number;
					profile_picture_url?: string;
				}>(`/${pageDetails.instagram_business_account.id}`, {
					accessToken: pageTokenRow.accessToken,
					params: {
						fields:
							'id,username,followers_count,follows_count,media_count,profile_picture_url'
					},
					endpointLabel: 'instagram_profile_snapshot'
				});

				const existingProfile = await this.metaInstagramProfilesRepo.findOne({
					where: { instagramId: instagramDetails.id }
				});

				const instagramPayload = {
					instagramId: instagramDetails.id,
					pageId: pageDetails.id,
					username: instagramDetails.username ?? null,
					followers:
						instagramDetails.followers_count !== undefined
							? String(instagramDetails.followers_count)
							: null,
					follows:
						instagramDetails.follows_count !== undefined
							? String(instagramDetails.follows_count)
							: null,
					mediaCount:
						instagramDetails.media_count !== undefined
							? String(instagramDetails.media_count)
							: null,
					postCount:
						instagramDetails.media_count !== undefined
							? String(instagramDetails.media_count)
							: null,
					profilePictureUrl: instagramDetails.profile_picture_url ?? null,
					lastIngestedAt: new Date()
				};

				instagramRecord = existingProfile
					? await existingProfile.update(instagramPayload)
					: await this.metaInstagramProfilesRepo.create(instagramPayload);
				this.logIngestProgress(
					'profile_snapshot',
					run.id,
					`stored Instagram profile snapshot for instagramId=${instagramDetails.id}`
				);
			} else {
				this.logIngestProgress(
					'profile_snapshot',
					run.id,
					'Instagram profile ingest skipped because the page is not linked to an Instagram business account'
				);
			}

			const snapshotDate = this.formatDate(new Date());
			const pageInsightsRange = historicalRange || {
				startDate: snapshotDate,
				endDate: snapshotDate
			};
			this.logIngestProgress(
				'profile_snapshot',
				run.id,
				`starting Facebook page insights ingest for range=${pageInsightsRange.startDate}..${pageInsightsRange.endDate}`
			);
			const pageInsightsResult = await this.ingestFacebookPageInsights(
				pageTokenRow.accessToken,
				pageDetails.id,
				pageDetails.name ?? null,
				pageInsightsRange.startDate,
				pageInsightsRange.endDate,
				{ includeGeoSnapshots: !isHistoricalInsightsBackfill }
			);
			warnings.push(...pageInsightsResult.warnings);
			this.logIngestProgress(
				'profile_snapshot',
				run.id,
				`completed Facebook page insights ingest: upserted=${pageInsightsResult.upserted} geoRows=${pageInsightsResult.geoRowsUpserted} warnings=${pageInsightsResult.warnings.length}`
			);
			let instagramGeoRowsUpserted = 0;
			let instagramDemographicRowsUpserted = 0;
			let instagramAccountInsightRowsUpserted = 0;

			if (pageDetails.instagram_business_account?.id) {
				if (isHistoricalInsightsBackfill) {
					warnings.push(
						'Instagram audience geo/demographics were skipped for historical backfill because Meta exposes those audience snapshots only as current timeframe aggregates, not day-by-day history.'
					);
					this.logIngestProgress(
						'profile_snapshot',
						run.id,
						`skipped Instagram audience geo/demographics historical backfill for instagramId=${pageDetails.instagram_business_account.id}`
					);
				} else {
					this.logIngestProgress(
						'profile_snapshot',
						run.id,
						`starting Instagram audience geo/demographics ingest for instagramId=${pageDetails.instagram_business_account.id}`
					);
					const instagramGeoResult = await this.ingestInstagramAudienceGeo(
						pageTokenRow.accessToken,
						pageDetails.instagram_business_account.id,
						instagramRecord?.username ?? null,
						snapshotDate,
						snapshotDate
					);
					instagramGeoRowsUpserted = instagramGeoResult.geoRowsUpserted;
					instagramDemographicRowsUpserted = instagramGeoResult.demographicRowsUpserted;
					warnings.push(...instagramGeoResult.warnings);
					this.logIngestProgress(
						'profile_snapshot',
						run.id,
						`completed Instagram audience geo/demographics ingest: geoRows=${instagramGeoResult.geoRowsUpserted} demographicRows=${instagramGeoResult.demographicRowsUpserted} warnings=${instagramGeoResult.warnings.length}`
					);
				}

				const accountInsightsResult = await this.ingestInstagramAccountInsights(
					pageTokenRow.accessToken,
					pageDetails.instagram_business_account.id,
					historicalRange
						? {
							startDate: historicalRange.startDate,
							endDate: historicalRange.endDate
						}
						: undefined
				);
				instagramAccountInsightRowsUpserted = accountInsightsResult.upserted;
				warnings.push(...accountInsightsResult.warnings);
				this.logIngestProgress(
					'profile_snapshot',
					run.id,
					`completed Instagram account insights ingest: rows=${accountInsightsResult.upserted} days=${accountInsightsResult.days.join(',')} warnings=${accountInsightsResult.warnings.length}`
				);
			}

			this.logIngestProgress(
				'profile_snapshot',
				run.id,
				`finalizing run with warnings=${warnings.length}`
			);
			const totalRecordsUpserted =
				(instagramRecord ? 2 : 1) +
				pageInsightsResult.upserted +
				pageInsightsResult.geoRowsUpserted +
				instagramGeoRowsUpserted +
				instagramDemographicRowsUpserted +
				instagramAccountInsightRowsUpserted;
			await run.update({
				status: 'completed',
				finishedAt: new Date(),
				recordsProcessed: totalRecordsUpserted,
				lastError: null
			});
			await this.ingestionRunsService.completeRun(sharedRun.id, {
				entityId: options?.pageId ?? pageDetails.id ?? 'default',
				...(historicalRange
					? {
						scopeStartDate: historicalRange.startDate,
						scopeEndDate: historicalRange.endDate
					}
					: {}),
				recordsFetched: totalRecordsUpserted,
				recordsProcessed: totalRecordsUpserted,
				recordsUpserted: totalRecordsUpserted,
				metadata: {
					pageId: options?.pageId ?? pageDetails.id ?? null,
					startDate: historicalRange?.startDate ?? null,
					endDate: historicalRange?.endDate ?? null,
					historicalInsightsBackfill: isHistoricalInsightsBackfill,
					warnings
				}
			});

			return {
				statusCode: HttpStatus.OK,
				message: 'Meta profile snapshot ingested successfully',
				data: {
					runId: run.id,
					range: historicalRange,
					facebookPage: pageRecord,
					instagramProfile: instagramRecord,
					pageInsightsUpserted: pageInsightsResult.upserted,
					audienceGeoRowsUpserted:
						pageInsightsResult.geoRowsUpserted + instagramGeoRowsUpserted,
					audienceDemographicRowsUpserted: instagramDemographicRowsUpserted,
					accountInsightRowsUpserted: instagramAccountInsightRowsUpserted,
					warnings
				}
			};
		} catch (error: any) {
			const errorMessage =
				error?.response?.data?.error?.message ||
				error?.message ||
				'Unknown Meta profile ingestion error';
			this.logger.error(`Meta ingest [profile_snapshot#${run.id}] failed: ${errorMessage}`);
			await run.update({
				status: 'failed',
				finishedAt: new Date(),
				lastError: errorMessage
			});
			await this.ingestionRunsService.failRun(sharedRun.id, error, {
				entityId: options?.pageId ?? 'default'
			});

			throw new BadGatewayException(
				`Unable to ingest Meta profile snapshot: ${errorMessage}`
			);
		}
	}

	async ingestGeoSnapshot(options?: {
		pageId?: string;
		instagramId?: string;
		startDate?: string;
		endDate?: string;
		scope?: string;
		runType?: string;
		triggerSource?: string;
	}) {
		const range = this.resolveContentDateRange(options?.startDate, options?.endDate, 30);
		// Claim the shared run first: it is the cross-instance guard, and if another
		// instance already holds this job there must be no Meta-local row left "running".
		const sharedRun = await this.claimSharedRun({
			platform: 'meta',
			entityType: 'page',
			entityId: options?.pageId ?? 'default',
			jobType: 'geo_snapshot',
			runType: options?.runType ?? 'manual',
			triggerSource: options?.triggerSource ?? 'http',
			status: 'running',
			scopeStartDate: range.startDate,
			scopeEndDate: range.endDate,
			metadata: {
				pageId: options?.pageId ?? null,
				instagramId: options?.instagramId ?? null,
				startDate: range.startDate,
				endDate: range.endDate
			},
			startedAt: new Date()
		});
		const run = await this.metaIngestionRunsRepo.create({
			jobType: 'geo_snapshot',
			scope: options?.scope ?? 'manual',
			status: 'running',
			startedAt: sharedRun.startedAt,
			finishedAt: null,
			retryCount: 0,
			recordsProcessed: 0,
			lastError: null,
			metadata: JSON.stringify({
				pageId: options?.pageId ?? null,
				instagramId: options?.instagramId ?? null,
				startDate: range.startDate,
				endDate: range.endDate
			})
		});

		try {
			this.logIngestProgress(
				'geo_snapshot',
				run.id,
				`started for pageId=${options?.pageId ?? 'default'} instagramId=${options?.instagramId ?? 'auto'} range=${range.startDate}..${range.endDate}`
			);
			const pageTokenRow = await this.metaAuthService.getEffectivePageToken(options?.pageId);
			this.logIngestProgress(
				'geo_snapshot',
				run.id,
				`resolved page token for pageId=${pageTokenRow.pageId} instagramBusinessAccountId=${pageTokenRow.instagramBusinessAccountId ?? 'none'}`
			);
			const pageRecord = await this.metaFacebookPagesRepo.findOne({
				where: { pageId: pageTokenRow.pageId }
			});
			this.logIngestProgress(
				'geo_snapshot',
				run.id,
				`starting Facebook audience geo ingest for pageId=${pageTokenRow.pageId}`
			);
			const facebookResult = await this.ingestFacebookPageInsights(
				pageTokenRow.accessToken,
				pageTokenRow.pageId,
				pageRecord?.name ?? null,
				range.startDate,
				range.endDate
			);
			this.logIngestProgress(
				'geo_snapshot',
				run.id,
				`completed Facebook audience geo ingest: upserted=${facebookResult.upserted} geoRows=${facebookResult.geoRowsUpserted} warnings=${facebookResult.warnings.length}`
			);
			const instagramId = await this.resolveInstagramAccountId(
				pageTokenRow.pageId,
				pageTokenRow.instagramBusinessAccountId ?? null,
				options?.instagramId
			);
			const instagramProfile = instagramId
				? await this.metaInstagramProfilesRepo.findOne({
					where: { instagramId }
				})
				: null;
			const instagramResult = instagramId
				? await this.ingestInstagramAudienceGeo(
					pageTokenRow.accessToken,
					instagramId,
					instagramProfile?.username ?? null,
					range.startDate,
					range.endDate
				)
				: { geoRowsUpserted: 0, warnings: ['Instagram geo snapshot skipped: no Instagram account could be resolved'] };
			if (instagramId) {
				this.logIngestProgress(
					'geo_snapshot',
					run.id,
					`completed Instagram audience geo ingest for instagramId=${instagramId}: geoRows=${instagramResult.geoRowsUpserted} warnings=${instagramResult.warnings.length}`
				);
			} else {
				this.logIngestProgress(
					'geo_snapshot',
					run.id,
					'Instagram audience geo ingest skipped because no Instagram account could be resolved'
				);
			}

			const recordsProcessed =
				facebookResult.geoRowsUpserted + instagramResult.geoRowsUpserted;
			const warnings = [...facebookResult.warnings, ...instagramResult.warnings];
			this.logIngestProgress(
				'geo_snapshot',
				run.id,
				`finalizing run with recordsProcessed=${recordsProcessed} warnings=${warnings.length}`
			);

			await run.update({
				status: 'completed',
				finishedAt: new Date(),
				recordsProcessed,
				lastError: warnings.length ? warnings.join(' | ') : null
			});
			await this.ingestionRunsService.completeRun(sharedRun.id, {
				entityId: pageTokenRow.pageId,
				recordsFetched: recordsProcessed,
				recordsProcessed,
				recordsUpserted: recordsProcessed,
				metadata: {
					pageId: pageTokenRow.pageId,
					instagramId: instagramId ?? null,
					startDate: range.startDate,
					endDate: range.endDate,
					warnings
				}
			});

			return {
				statusCode: HttpStatus.OK,
				message: 'Meta geo snapshot ingested successfully',
				data: {
					runId: run.id,
					range,
					pageId: pageTokenRow.pageId,
					instagramId: instagramId ?? null,
					facebookGeoRowsUpserted: facebookResult.geoRowsUpserted,
					instagramGeoRowsUpserted: instagramResult.geoRowsUpserted,
					warnings
				}
			};
		} catch (error: any) {
			const errorMessage =
				error?.response?.data?.error?.message ||
				error?.message ||
				'Unknown Meta geo ingestion error';
			this.logger.error(`Meta ingest [geo_snapshot#${run.id}] failed: ${errorMessage}`);
			await run.update({
				status: 'failed',
				finishedAt: new Date(),
				lastError: errorMessage
			});
			await this.ingestionRunsService.failRun(sharedRun.id, error, {
				entityId: options?.pageId ?? 'default'
			});
			throw new BadGatewayException(
				`Unable to ingest Meta geo snapshot: ${errorMessage}`
			);
		}
	}

	/**
	 * Stories expire after 24h, so this is its own poll rather than piggybacking on
	 * content_snapshot's 6-hourly cadence (see METRICS_BACKLOG.txt item 2) — a story
	 * published and gone between two content_snapshot runs would never be seen. Facebook
	 * page stories are confirmed blocked at the Graph API level (probed live 2026-09-18,
	 * same error across 3 API versions), so this only ever ingests Instagram.
	 */
	async ingestStorySnapshot(options?: {
		pageId?: string;
		instagramId?: string;
		scope?: string;
		runType?: string;
		triggerSource?: string;
	}) {
		const capturedAt = new Date();
		const sharedRun = await this.claimSharedRun({
			platform: 'meta',
			entityType: 'page',
			entityId: options?.pageId ?? 'default',
			jobType: 'story_snapshot',
			runType: options?.runType ?? 'manual',
			triggerSource: options?.triggerSource ?? 'http',
			status: 'running',
			metadata: {
				pageId: options?.pageId ?? null,
				instagramId: options?.instagramId ?? null
			},
			startedAt: capturedAt
		});
		const run = await this.metaIngestionRunsRepo.create({
			jobType: 'story_snapshot',
			scope: options?.scope ?? 'manual',
			status: 'running',
			startedAt: sharedRun.startedAt,
			finishedAt: null,
			retryCount: 0,
			recordsProcessed: 0,
			lastError: null,
			metadata: JSON.stringify({
				pageId: options?.pageId ?? null,
				instagramId: options?.instagramId ?? null
			})
		});

		try {
			this.logIngestProgress(
				'story_snapshot',
				run.id,
				`started for pageId=${options?.pageId ?? 'default'} instagramId=${options?.instagramId ?? 'auto'}`
			);
			const pageTokenRow = await this.metaAuthService.getEffectivePageToken(options?.pageId);
			const instagramId = await this.resolveInstagramAccountId(
				pageTokenRow.pageId,
				pageTokenRow.instagramBusinessAccountId ?? null,
				options?.instagramId
			);

			const warnings: string[] = [];
			let upserted = 0;
			if (instagramId) {
				const result = await this.ingestInstagramStorySnapshot(
					pageTokenRow.accessToken,
					instagramId,
					capturedAt
				);
				upserted = result.upserted;
				warnings.push(...result.warnings);
				this.logIngestProgress(
					'story_snapshot',
					run.id,
					`completed Instagram story ingest for instagramId=${instagramId}: upserted=${upserted} warnings=${warnings.length}`
				);
			} else {
				warnings.push('Instagram story snapshot skipped: no Instagram account could be resolved');
			}

			await run.update({
				status: 'completed',
				finishedAt: new Date(),
				recordsProcessed: upserted,
				lastError: warnings.length ? warnings.join(' | ') : null
			});
			await this.ingestionRunsService.completeRun(sharedRun.id, {
				entityId: pageTokenRow.pageId,
				recordsFetched: upserted,
				recordsProcessed: upserted,
				recordsUpserted: upserted,
				metadata: {
					pageId: pageTokenRow.pageId,
					instagramId: instagramId ?? null,
					capturedAt: capturedAt.toISOString(),
					warnings
				}
			});

			return {
				statusCode: HttpStatus.OK,
				message: 'Meta story snapshot ingested successfully',
				data: {
					runId: run.id,
					pageId: pageTokenRow.pageId,
					instagramId: instagramId ?? null,
					capturedAt: capturedAt.toISOString(),
					upserted,
					warnings
				}
			};
		} catch (error: any) {
			const errorMessage = this.getErrorMessage(error);
			this.logger.error(`Meta ingest [story_snapshot#${run.id}] failed: ${errorMessage}`);
			await run.update({
				status: 'failed',
				finishedAt: new Date(),
				lastError: errorMessage
			});
			await this.ingestionRunsService.failRun(sharedRun.id, error, {
				entityId: options?.pageId ?? 'default'
			});
			throw new BadGatewayException(`Unable to ingest Meta story snapshot: ${errorMessage}`);
		}
	}

	/**
	 * Metric set confirmed live 2026-09-18 against v25.0 on a real IG story
	 * (18013159913752336): impressions is deprecated (gone since v22.0, same pattern as
	 * Facebook's page_impressions retirement) and taps_forward/taps_back/exits from the
	 * original backlog note no longer exist as separate metrics — Meta folded them into a
	 * single "navigation" aggregate. Valid set used here: reach, replies, navigation,
	 * total_interactions, views.
	 */
	private async ingestInstagramStorySnapshot(
		accessToken: string,
		instagramId: string,
		capturedAt: Date
	) {
		const warnings: string[] = [];
		let stories: Array<{
			id?: string;
			media_type?: string;
			permalink?: string;
			timestamp?: string;
		}>;
		try {
			stories = await this.fetchPaginatedEdge<{
				id?: string;
				media_type?: string;
				permalink?: string;
				timestamp?: string;
			}>(
				`/${instagramId}/stories`,
				accessToken,
				{ fields: 'id,media_type,permalink,timestamp', limit: 50 },
				'instagram_stories_story_snapshot',
				10
			);
		} catch (error: any) {
			const message = this.getErrorMessage(error);
			warnings.push(`Failed to list Instagram stories for instagramId=${instagramId}: ${message}`);
			return { upserted: 0, warnings };
		}

		let upserted = 0;
		for (const story of stories) {
			const storyId = String(story?.id || '').trim();
			if (!storyId) continue;

			try {
				const response = await this.metaApiService.get<{
					data?: Array<{ name?: string; values?: Array<{ value?: number | string }> }>;
				}>(`/${storyId}/insights`, {
					accessToken,
					params: { metric: 'reach,replies,navigation,total_interactions,views' },
					endpointLabel: 'instagram_story_insights_story_snapshot'
				});
				const reduced = this.reduceMetaInsightRows(response.data || [], {
					reach: ['reach'],
					views: ['views'],
					replies: ['replies'],
					navigation: ['navigation'],
					totalInteractions: ['total_interactions']
				});

				await this.metaInstagramStoryStatsRepo.create({
					storyId,
					instagramId,
					mediaType: story.media_type ?? null,
					permalink: story.permalink ?? null,
					postedAt: story.timestamp ? new Date(story.timestamp) : null,
					capturedAt,
					reach: this.toStringOrNull(reduced.reach),
					views: this.toStringOrNull(reduced.views),
					replies: this.toStringOrNull(reduced.replies),
					navigation: this.toStringOrNull(reduced.navigation),
					totalInteractions: this.toStringOrNull(reduced.totalInteractions),
					rawJson: JSON.stringify(response.data || [])
				});
				upserted += 1;
			} catch (error: any) {
				const message = this.getErrorMessage(error);
				warnings.push(`Failed to fetch insights for Instagram story ${storyId}: ${message}`);
			}
		}

		return { upserted, warnings };
	}

	private async ingestFacebookPosts(
		accessToken: string,
		pageId: string,
		range: { startDate: string; endDate: string },
		maxItems?: number | null,
		onProgress?: (progress: {
			platform: 'facebook';
			assetId: string;
			processed: number;
			total: number;
		}) => Promise<void>,
		onFailure?: (failure: {
			platform: 'facebook';
			assetId: string;
			reasons: string[];
			}) => Promise<void>
	) {
		const rows = await this.fetchFacebookPostRows(accessToken, pageId, range, maxItems);
		const fetchedAtByAssetId = await this.getLatestFetchedAtByAssetId(
			'facebook',
			rows.map((row) => String(row?.id || '')).filter(Boolean)
		);
		// Reels aren't in `rows` at all (see fetchFacebookReelMetricsByPost) — fetched once per
		// run, keyed by the page-post id they map back to, and merged in below per post.
		const reelMetricsByPost = await this.fetchFacebookReelMetricsByPost(pageId, accessToken);
		const tierSummary = createEmptyTierSummary();

		let created = 0;
		let updated = 0;
		let processed = 0;
		const total = rows.length;

		for (const row of rows) {
			const assetId = String(row?.id || '').trim();
			if (!assetId) continue;

			const tier = classifyContentTier(row.created_time);
			tierSummary[tier]++;
			const due = isRefreshDue(tier, fetchedAtByAssetId.get(assetId) ?? null);
			const throttled = tier !== 'hot' && this.shouldThrottleLowerPriorityWork();
			const shouldRefreshInsights = due && !throttled;
			if (due && throttled) {
				tierSummary.skippedForBudget++;
			}

			this.logger.log(
				`Meta content ingest: processing Facebook post ${assetId} (${processed + 1}/${total}) tier=${tier} refreshInsights=${shouldRefreshInsights}`
			);
			const metrics = shouldRefreshInsights
				? await this.fetchFacebookPostMetrics(assetId, accessToken)
				: this.emptyFacebookPostMetricsResult();
			const breakdownMetrics = shouldRefreshInsights
				? await this.fetchFacebookPostBreakdownMetrics(assetId, accessToken)
				: { reactionsByType: null, videoRetentionGraph: null, errors: [] as string[] };
			const postDetails = this.extractFacebookPostDetailsFromRow(row);
			const counts = this.extractFacebookPostCountsFromRow(row);
			if (counts.reactionsFieldMissing || counts.commentsFieldMissing) {
				await this.recordFacebookPostCountsFieldGapOnce(pageId, counts);
			}
			const assetErrors = [...metrics.errors, ...breakdownMetrics.errors];
			const likes = Number(counts.likes ?? 0);
			const comments = Number(counts.comments ?? 0);
			const shares = Number(counts.shares ?? 0);
			const interactions = likes + comments + shares;
			const rawJson = JSON.stringify({
				...row,
				permalink_url: postDetails.permalink,
				attachments: postDetails.attachments
			});
			// Fields that come free from the list row (Phase 1's field-expansion) are always
			// current and safe to write. Insight-derived metrics are only included in the
			// write when they were actually refreshed this pass — otherwise a skipped
			// (not-due / budget-throttled) tier would null out real data fetched on a prior run.
			const basePayload = {
				postId: assetId,
				pageId,
				message: row.message ?? null,
				createdTime: row.created_time ? new Date(row.created_time) : null,
				permalink: postDetails.permalink,
				type: postDetails.type,
				statusType: postDetails.statusType,
				shares: this.toStringOrNull(counts.shares),
				likes: this.toStringOrNull(counts.likes),
				comments: this.toStringOrNull(counts.comments),
				interactions: this.toStringOrNull(interactions),
				rawJson
			};
			const reelMetrics = reelMetricsByPost.get(assetId) ?? null;
			const metricFields = shouldRefreshInsights
				? {
					reach: this.toStringOrNull(metrics.reach),
					impressions: this.toStringOrNull(metrics.impressions),
					engagement: metrics.engagementAvailable
						? this.toStringOrNull(metrics.engagement)
						: null,
					engagementSource: metrics.engagementAvailable ? 'meta' : null,
					videoViews: this.toStringOrNull(metrics.videoViews),
					videoAvgTimeWatchedMs: this.toStringOrNull(metrics.videoAvgTimeWatched),
					videoCompleteViews30s: this.toStringOrNull(metrics.videoCompleteViews30s),
					reactionsByType: breakdownMetrics.reactionsByType,
					videoRetentionGraph: breakdownMetrics.videoRetentionGraph,
					// Only reel posts have an entry here; non-reel posts keep these null.
					blueReelsPlayCount: this.toStringOrNull(reelMetrics?.blueReelsPlayCount ?? null),
					fbReelsTotalPlays: this.toStringOrNull(reelMetrics?.fbReelsTotalPlays ?? null),
					reelPostViews: this.toStringOrNull(reelMetrics?.reelPostViews ?? null),
					reelLengthSeconds: reelMetrics?.reelLengthSeconds ?? null
				}
				: {};
			const payload = { ...basePayload, ...metricFields };

			if (!payload.postId) continue;

			const existing = await this.metaFacebookPostsRepo.findOne({
				where: { postId: payload.postId }
			});
			if (existing) {
				await existing.update(payload);
				updated++;
			} else {
				await this.metaFacebookPostsRepo.create(payload);
				created++;
			}

			if (shouldRefreshInsights) {
				await this.upsertContentMetricSnapshot({
					platform: 'facebook',
					assetType: postDetails.type || postDetails.statusType || 'post',
					assetId,
					accountId: pageId,
					likes,
					comments,
					shares,
					saved: null,
					reach: metrics.reach,
					impressions: metrics.impressions,
					engagement: metrics.engagementAvailable ? metrics.engagement : null,
					interactions,
					views: metrics.videoViews,
					engagementSource: metrics.engagementAvailable ? 'meta' : null,
					rawJson
				});
			}

			if (metrics.videoViews !== null) {
				await this.attemptFacebookPostVideoGeoBreakdown(
					assetId,
					pageId,
					row.message ? String(row.message).slice(0, 200) : null,
					accessToken,
					range.startDate,
					range.endDate
				);
			}

			if (assetErrors.length && onFailure) {
				await onFailure({
					platform: 'facebook',
					assetId,
					reasons: assetErrors
				});
			}

			processed++;
			if (onProgress) {
				await onProgress({
					platform: 'facebook',
					assetId,
					processed,
					total
				});
			}
		}

		return { created, updated, processed, total, tierSummary };
	}

	private emptyFacebookPostMetricsResult() {
		return {
			reach: null as number | null,
			impressions: null as number | null,
			engagement: null as number | null,
			videoViews: null as number | null,
			videoAvgTimeWatched: null as number | null,
			videoCompleteViews30s: null as number | null,
			engagementAvailable: false,
			errors: [] as string[]
		};
	}

	/**
	 * Graph exposes no total-post-count field for a Page, so the only way to count is to walk
	 * the whole history at 100 ids per call. For a page with tens of thousands of posts that
	 * is hundreds of calls — more than the app's hourly budget — and it was tripping the
	 * rate limit every night before it finished, after which the resulting cooldown failed
	 * the Instagram half of the profile snapshot. Cap the walk well inside the budget; a page
	 * that outgrows the cap reports the count as unobtainable rather than burning the budget.
	 */
	private readonly facebookPostCountMaxPosts = 2000;

	private async fetchFacebookPagePostCount(
		accessToken: string,
		pageId: string
	) {
		const candidates = [
			{ path: `/${pageId}/published_posts`, label: 'facebook_page_total_post_count_published_posts' },
			{ path: `/${pageId}/posts`, label: 'facebook_page_total_post_count_posts' },
			{ path: `/${pageId}/feed`, label: 'facebook_page_total_post_count_feed' }
		];
		const pageSize = 100;
		// Ask for one row past the cap: getting it back is the proof the history is longer
		// than we are willing to walk, without a second request to check.
		const maxItems = this.facebookPostCountMaxPosts + 1;
		const maxPages = Math.ceil(maxItems / pageSize);

		let lastError: any = null;
		for (const candidate of candidates) {
			try {
				const rows = await this.fetchPaginatedEdge<any>(
					candidate.path,
					accessToken,
					{
						fields: 'id',
						limit: pageSize
					},
					candidate.label,
					maxPages,
					maxItems
				);
				if (rows.length > this.facebookPostCountMaxPosts) {
					await this.dataCoverageService.recordAttempt({
						platform: 'meta',
						jobType: 'profile_snapshot',
						metricKey: 'facebook.page.post_count',
						scope: pageId,
						success: false,
						status: 'unavailable_unsupported',
						reason: `Page has more than ${this.facebookPostCountMaxPosts} published posts; Graph has no total-count field and walking the full history would exceed the hourly call budget.`
					});
					return null;
				}
				await this.dataCoverageService.recordAttempt({
					platform: 'meta',
					jobType: 'profile_snapshot',
					metricKey: 'facebook.page.post_count',
					scope: pageId,
					success: true
				});
				return rows.length;
			} catch (error: any) {
				lastError = error;
				const errorMessage =
					error?.response?.data?.error?.message ||
					error?.message ||
					'Unknown Facebook page total post count error';
				if (!String(errorMessage).toLowerCase().includes('deprecated')) {
					break;
				}
			}
		}

		if (lastError) {
			this.logger.warn(
				`Meta profile ingest: unable to resolve Facebook total post count for page ${pageId}: ${
					lastError?.response?.data?.error?.message ||
					lastError?.message ||
					'Unknown Meta API error'
				}`
			);
		}

		return null;
	}

	private async fetchFacebookPostRows(
		accessToken: string,
		pageId: string,
		range: { startDate: string; endDate: string },
		maxItems?: number | null
	) {
		const params = {
			fields: [
				'id',
				'message',
				'created_time',
				'full_picture',
				'picture',
				'permalink_url',
				'attachments{media_type,type,url,title,media,target,subattachments}',
				'reactions.summary(true).limit(0)',
				'comments.summary(true).limit(0)',
				'shares'
			].join(','),
			since: range.startDate,
			until: range.endDate
		};
		const candidates = [
			{ path: `/${pageId}/posts`, label: 'facebook_posts_content_snapshot_posts' },
			{ path: `/${pageId}/published_posts`, label: 'facebook_posts_content_snapshot_published_posts' },
			{ path: `/${pageId}/feed`, label: 'facebook_posts_content_snapshot_feed' }
		];
		// With the attachments/reactions/comments field expansion above, a 100-row page can
		// exceed what Graph will assemble in one response ("Please reduce the amount of data
		// you're asking for"). Meta's remedy is a smaller page, so step down before giving up;
		// the page budget scales inversely so the overall item ceiling stays the same.
		const pageSizes = [100, 25, 10];
		const maxItemsAtFullPage = 50 * pageSizes[0];

		let lastError: any = null;
		for (const candidate of candidates) {
			for (const limit of pageSizes) {
				try {
					const rows = await this.fetchPaginatedEdge<any>(
						candidate.path,
						accessToken,
						{ ...params, limit },
						candidate.label,
						Math.ceil(maxItemsAtFullPage / limit),
						maxItems ?? undefined
					);
					if (rows.length) {
						return rows;
					}
					break;
				} catch (error: any) {
					lastError = error;
					const errorMessage = String(
						error?.response?.data?.error?.message ||
							error?.message ||
							'Unknown Facebook posts edge error'
					).toLowerCase();
					if (this.isReduceDataError(error) && limit !== pageSizes[pageSizes.length - 1]) {
						this.logger.warn(
							`Meta content ingest: ${candidate.path} rejected page size ${limit} as too much data; retrying with a smaller page`
						);
						continue;
					}
					if (!errorMessage.includes('deprecated')) {
						throw error;
					}
					break;
				}
			}
		}

		if (lastError) {
			throw lastError;
		}

		return [];
	}

	/**
	 * Graph error code 1 with this message is not throttling — it means the requested page
	 * is too expensive to assemble (large field expansion × page size). Retrying the same
	 * query later fails the same way; only a smaller request succeeds.
	 */
	private isReduceDataError(error: any) {
		const message = String(
			error?.response?.data?.error?.message || error?.message || ''
		).toLowerCase();
		return message.includes('reduce the amount of data');
	}

	private async ingestInstagramMedia(
		accessToken: string,
		instagramId: string,
		range: { startDate: string; endDate: string },
		maxItems?: number | null,
		onProgress?: (progress: {
			platform: 'instagram';
			assetId: string;
			processed: number;
			total: number;
		}) => Promise<void>,
		onFailure?: (failure: {
			platform: 'instagram';
			assetId: string;
			reasons: string[];
		}) => Promise<void>
	) {
			const rows = await this.fetchPaginatedEdge<any>(
				`/${instagramId}/media`,
				accessToken,
				{
					fields: 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count',
					since: range.startDate,
					until: range.endDate,
					limit: 100
				},
				'instagram_media_content_snapshot',
				50,
				maxItems ?? undefined
			);

		const fetchedAtByAssetId = await this.getLatestFetchedAtByAssetId(
			'instagram',
			rows.map((row) => String(row?.id || '')).filter(Boolean)
		);
		const tierSummary = createEmptyTierSummary();

		let created = 0;
		let updated = 0;
		let processed = 0;
		const total = rows.length;

		for (const row of rows) {
			const assetId = String(row?.id || '').trim();
			if (!assetId) continue;

			const tier = classifyContentTier(row.timestamp);
			tierSummary[tier]++;
			const due = isRefreshDue(tier, fetchedAtByAssetId.get(assetId) ?? null);
			const throttled = tier !== 'hot' && this.shouldThrottleLowerPriorityWork();
			const shouldRefreshInsights = due && !throttled;
			if (due && throttled) {
				tierSummary.skippedForBudget++;
			}

			this.logger.log(
				`Meta content ingest: processing Instagram media ${assetId} (${processed + 1}/${total}) tier=${tier} refreshInsights=${shouldRefreshInsights}`
			);

			const insightResult = shouldRefreshInsights
				? await this.fetchInstagramMediaInsightRows(
					assetId,
					accessToken,
					String(row.media_type || '')
				)
				: { rows: [] as any[], errors: [] as string[] };
			const insights = this.reduceMetaInsightRows(insightResult.rows, {
				engagement: ['total_interactions', 'engagement'],
				impressions: ['impressions'],
				reach: ['reach'],
				saved: ['saved'],
				shares: ['shares'],
				videoViews: ['views', 'video_views', 'total_views'],
				reelsAvgWatchTimeMs: ['ig_reels_avg_watch_time'],
				reelsTotalWatchTimeMs: ['ig_reels_video_view_total_time']
			});
			const likes = Number(row.like_count ?? 0);
			const comments = Number(row.comments_count ?? 0);
			const saved = Number(insights.saved ?? 0);
			const shares = Number(insights.shares ?? 0);
			const interactions = likes + comments + saved + shares;
			const rawJson = JSON.stringify(row);
			// Same reasoning as ingestFacebookPosts: insight-derived fields only get written
			// when actually refreshed this pass, so a skipped tier never nulls out real data
			// fetched on a prior run.
			const basePayload = {
				mediaId: assetId,
				instagramId,
				caption: row.caption ?? null,
				mediaType: row.media_type ?? null,
				mediaUrl: row.media_url ?? null,
				permalink: row.permalink ?? null,
				timestamp: row.timestamp ? new Date(row.timestamp) : null,
				likeCount: this.toStringOrNull(row.like_count),
				commentsCount: this.toStringOrNull(row.comments_count),
				rawJson
			};
			const metricFields = shouldRefreshInsights
				? {
					saved: this.toStringOrNull(insights.saved),
					shares: this.toStringOrNull(insights.shares),
					reelsAvgWatchTimeMs: this.toStringOrNull(insights.reelsAvgWatchTimeMs),
					reelsTotalWatchTimeMs: this.toStringOrNull(insights.reelsTotalWatchTimeMs),
					reach: this.toStringOrNull(insights.reach),
					impressions: this.toStringOrNull(insights.impressions),
					engagement: this.toStringOrNull(insights.engagement),
					videoViews: this.toStringOrNull(insights.videoViews)
				}
				: {};
			const payload = { ...basePayload, ...metricFields };

			if (!payload.mediaId) continue;

			if (insightResult.rows.length) {
				await this.upsertInstagramMediaInsightRows(
					payload.mediaId,
					instagramId,
					insightResult.rows
				);
			}

			const existing = await this.metaInstagramMediaRepo.findOne({
				where: { mediaId: payload.mediaId }
			});
			if (existing) {
				await existing.update(payload);
				updated++;
			} else {
				await this.metaInstagramMediaRepo.create(payload);
				created++;
			}

			if (shouldRefreshInsights) {
				await this.upsertContentMetricSnapshot({
					platform: 'instagram',
					assetType: row.media_type || 'media',
					assetId,
					accountId: instagramId,
					likes,
					comments,
					shares,
					saved,
					reach: insights.reach,
					impressions: insights.impressions,
					engagement: insights.engagement,
					interactions,
					views: insights.videoViews,
					engagementSource: 'meta',
					rawJson
				});
			}

			if (insightResult.errors.length && onFailure) {
				await onFailure({
					platform: 'instagram',
					assetId,
					reasons: insightResult.errors
				});
			}

			processed++;
			if (onProgress) {
				await onProgress({
					platform: 'instagram',
					assetId,
					processed,
					total
				});
			}
		}

		return { created, updated, processed, total, tierSummary };
	}

	/**
	 * One-off correction for media rows whose `shares` (and therefore `interactions`) got
	 * zeroed while the 'shares' metric was wrongly process-blacklisted (see
	 * extractRejectedInstagramMetrics's alwaysSafe fallback). Re-fetches just `shares` per
	 * media, using the row's already-stored likes/comments/saved to recompute interactions
	 * without a full insights re-fetch, and refreshes today's content metric snapshot to match.
	 */
	async backfillInstagramMediaShares(mediaIds: string[]) {
		const pageTokenRow = await this.metaAuthService.getEffectivePageToken();
		let updated = 0;
		const skipped: string[] = [];
		const errors: string[] = [];

		for (const mediaId of mediaIds) {
			const existing = await this.metaInstagramMediaRepo.findOne({ where: { mediaId } });
			if (!existing) {
				skipped.push(`${mediaId}: no MetaInstagramMedia row found`);
				continue;
			}

			try {
				const response = await this.metaApiService.get<{
					data?: Array<{ name?: string; values?: Array<{ value?: number | string }> }>;
				}>(`/${mediaId}/insights`, {
					accessToken: pageTokenRow.accessToken,
					params: { metric: 'shares' },
					endpointLabel: 'instagram_media_insights_shares_backfill'
				});
				const { shares } = this.reduceMetaInsightRows(response.data || [], { shares: ['shares'] });
				const likes = Number(existing.get('likeCount') ?? 0);
				const comments = Number(existing.get('commentsCount') ?? 0);
				const saved = Number(existing.get('saved') ?? 0);
				const sharesValue = Number(shares ?? 0);
				const interactions = likes + comments + saved + sharesValue;

				await existing.update({ shares: this.toStringOrNull(shares) });
				await this.upsertContentMetricSnapshot({
					platform: 'instagram',
					assetType: String(existing.get('mediaType') ?? 'media'),
					assetId: mediaId,
					accountId: String(existing.get('instagramId')),
					likes,
					comments,
					shares: sharesValue,
					saved,
					reach: existing.get('reach') !== null ? Number(existing.get('reach')) : null,
					impressions: existing.get('impressions') !== null ? Number(existing.get('impressions')) : null,
					engagement: existing.get('engagement') !== null ? Number(existing.get('engagement')) : null,
					interactions,
					views: existing.get('videoViews') !== null ? Number(existing.get('videoViews')) : null,
					engagementSource: 'meta',
					rawJson: existing.get('rawJson') as string | null
				});
				updated++;
			} catch (error: any) {
				errors.push(`${mediaId}: ${this.getErrorMessage(error)}`);
			}
		}

		return { updated, skipped, errors };
	}

	/**
	 * Facebook post details (permalink/type/attachments) are now requested via field
	 * expansion on the posts-list call itself (see fetchFacebookPostRows), so this just
	 * parses the already-fetched row instead of making a separate per-post API call.
	 */
	private extractFacebookPostDetailsFromRow(row: {
		permalink_url?: string;
		attachments?: {
			data?: Array<{
				media_type?: string;
				type?: string;
			}>;
		};
	}) {
		const primaryAttachment = row.attachments?.data?.[0];

		return {
			permalink: row.permalink_url ?? null,
			type: primaryAttachment?.media_type ?? primaryAttachment?.type ?? null,
			statusType: null,
			attachments: row.attachments ?? null
		};
	}

	private async fetchFacebookPostMetrics(postId: string, accessToken: string) {
		const metricConfigs: Array<{
			targetKey:
				| 'impressions'
				| 'reach'
				| 'engagement'
				| 'videoViews'
				| 'videoAvgTimeWatched'
				| 'videoCompleteViews30s';
			candidates: string[];
		}> = [
			{
				targetKey: 'impressions',
				candidates: ['post_media_view', 'post_impressions']
			},
			{
				targetKey: 'reach',
				candidates: ['post_total_media_view_unique', 'post_impressions_unique']
			},
			{
				targetKey: 'engagement',
				candidates: ['post_engaged_users']
			},
			{
				targetKey: 'videoViews',
				candidates: ['post_video_views']
			},
			{
				targetKey: 'videoAvgTimeWatched',
				candidates: ['post_video_avg_time_watched']
			},
			{
				targetKey: 'videoCompleteViews30s',
				candidates: ['post_video_complete_views_30s']
			}
		];
		const result = {
			reach: null as number | null,
			impressions: null as number | null,
			engagement: null as number | null,
			videoViews: null as number | null,
			videoAvgTimeWatched: null as number | null,
			videoCompleteViews30s: null as number | null,
			engagementAvailable: false,
			errors: [] as string[]
		};

		for (const config of metricConfigs) {
			let resolved = false;
			let lastError: any = null;
			const cachedMetricName = this.resolvedFacebookPostMetrics.get(config.targetKey);
			const candidateMetrics = cachedMetricName
				? [cachedMetricName]
				: config.candidates.filter(
						(metricName) => !this.unsupportedFacebookPostMetrics.has(metricName)
				  );

			if (!candidateMetrics.length) {
				continue;
			}

			for (const metricName of candidateMetrics) {
				try {
					const response = await this.metaApiService.get<{
						data?: Array<{
							name?: string;
							values?: Array<{ value?: number | string | Record<string, any> }>;
						}>;
					}>(`/${postId}/insights`, {
						accessToken,
						params: {
							metric: metricName,
							// Without period, Meta returns both a lifetime row and a day row (one
							// per day in whatever default window it picks) for some metrics
							// (post_video_views, post_total_media_view_unique,
							// post_video_avg_time_watched, ...). reduceMetaInsightRows takes the
							// last row it sees for a given metric name, so the day row (usually 0,
							// since these posts are older than the window) was silently clobbering
							// the real lifetime total. Pin to lifetime so only one row comes back.
							period: 'lifetime'
						},
						endpointLabel: 'facebook_post_insights_content_snapshot'
					});
					const reduced = this.reduceMetaInsightRows(response.data || [], {
						[config.targetKey]: [metricName]
					});
					result[config.targetKey] = reduced[config.targetKey];
					if (config.targetKey === 'engagement') {
						result.engagementAvailable = true;
					}
					this.resolvedFacebookPostMetrics.set(config.targetKey, metricName);
					resolved = true;
					break;
				} catch (error: any) {
					lastError = error;
					if (this.isInvalidFacebookPostMetricError(error)) {
						this.logUnsupportedFacebookPostMetric(metricName);
						if (this.resolvedFacebookPostMetrics.get(config.targetKey) === metricName) {
							this.resolvedFacebookPostMetrics.delete(config.targetKey);
						}
						continue;
					}

					break;
				}
			}

			if (!resolved && lastError && !this.isInvalidFacebookPostMetricError(lastError)) {
				result.errors.push(
					`${config.targetKey}: ${
						lastError?.response?.data?.error?.message ||
						lastError?.message ||
						'Unknown Facebook post insights error'
					}`
				);
			}
		}

		return result;
	}

	/**
	 * Reels never appear in fetchFacebookPostRows' /posts|/published_posts|/feed listing
	 * (verified live 2026-09-18, see METRICS_BACKLOG.txt item 3) — they're a separate object
	 * graph reached only via /{page-id}/video_reels, with their own id space. That listing's
	 * post_id field is the bridge back: it's the numeric suffix of the ordinary page-post id
	 * (post_id "1543447477821804" -> page-post id "{pageId}_1543447477821804"), so results are
	 * keyed by the full page-post id here to make the caller's lookup a plain Map.get(assetId).
	 * blue_reels_play_count and fb_reels_total_plays only resolve via /{reel-id}/video_insights
	 * (not /{postId}/insights, and not as a plain field on the reel object — both confirmed
	 * live). post_views/length come back free on the same /video_reels listing call.
	 */
	private async fetchFacebookReelMetricsByPost(pageId: string, accessToken: string) {
		const result = new Map<
			string,
			{
				blueReelsPlayCount: number | null;
				fbReelsTotalPlays: number | null;
				reelPostViews: number | null;
				reelLengthSeconds: number | null;
			}
		>();

		let reels: Array<{ id?: string; post_id?: string; post_views?: number; length?: number }>;
		try {
			reels = await this.fetchPaginatedEdge<{
				id?: string;
				post_id?: string;
				post_views?: number;
				length?: number;
			}>(
				`/${pageId}/video_reels`,
				accessToken,
				{ fields: 'id,post_id,post_views,length', limit: 50 },
				'facebook_video_reels_content_snapshot',
				20
			);
		} catch (error: any) {
			this.logger.warn(
				`Meta content ingest: failed to list Facebook reels for page ${pageId}: ${
					error?.response?.data?.error?.message || error?.message || 'Unknown error'
				}`
			);
			return result;
		}

		for (const reel of reels) {
			const reelId = String(reel?.id || '').trim();
			const shortPostId = String(reel?.post_id || '').trim();
			if (!reelId || !shortPostId) continue;
			const fullPostId = `${pageId}_${shortPostId}`;

			try {
				const response = await this.metaApiService.get<{
					data?: Array<{
						name?: string;
						values?: Array<{ value?: number | string | Record<string, any> }>;
					}>;
				}>(`/${reelId}/video_insights`, {
					accessToken,
					params: { metric: 'blue_reels_play_count,fb_reels_total_plays' },
					endpointLabel: 'facebook_reel_video_insights_content_snapshot'
				});
				const reduced = this.reduceMetaInsightRows(response.data || [], {
					blueReelsPlayCount: ['blue_reels_play_count'],
					fbReelsTotalPlays: ['fb_reels_total_plays']
				});
				result.set(fullPostId, {
					blueReelsPlayCount: reduced.blueReelsPlayCount,
					fbReelsTotalPlays: reduced.fbReelsTotalPlays,
					reelPostViews: this.normalizeInsightValue(reel.post_views) ?? null,
					reelLengthSeconds:
						typeof reel.length === 'number' && Number.isFinite(reel.length) ? reel.length : null
				});
			} catch (error: any) {
				this.logger.warn(
					`Meta content ingest: failed to fetch reel insights for reel ${reelId} (post ${fullPostId}): ${
						error?.response?.data?.error?.message || error?.message || 'Unknown error'
					}`
				);
			}
		}

		return result;
	}

	/**
	 * post_reactions_by_type_total and post_video_retention_graph both return structured
	 * values (a dict keyed by reaction type; a retention curve) rather than a single scalar,
	 * so unlike fetchFacebookPostMetrics they're stored as opaque JSON instead of being
	 * reduced to a number. post_video_retention_graph's exact shape was never confirmed
	 * against a real post (see METRICS_BACKLOG.txt item 1) — this stores whatever Meta
	 * returns as-is rather than assuming a structure.
	 */
	private async fetchFacebookPostBreakdownMetrics(postId: string, accessToken: string) {
		const metricConfigs: Array<{
			targetKey: 'reactionsByType' | 'videoRetentionGraph';
			metricName: string;
		}> = [
			{ targetKey: 'reactionsByType', metricName: 'post_reactions_by_type_total' },
			{ targetKey: 'videoRetentionGraph', metricName: 'post_video_retention_graph' }
		];
		const result = {
			reactionsByType: null as string | null,
			videoRetentionGraph: null as string | null,
			errors: [] as string[]
		};

		for (const config of metricConfigs) {
			if (this.unsupportedFacebookPostMetrics.has(config.metricName)) {
				continue;
			}

			try {
				const response = await this.metaApiService.get<{
					data?: Array<{
						name?: string;
						values?: Array<{ value?: number | string | Record<string, any> }>;
					}>;
				}>(`/${postId}/insights`, {
					accessToken,
					params: {
						metric: config.metricName,
						// See the matching comment in fetchFacebookPostMetrics: pin to lifetime so
						// a metric that also has a day-period default doesn't return multiple rows.
						period: 'lifetime'
					},
					endpointLabel: 'facebook_post_insights_content_snapshot'
				});
				const value = response.data?.[0]?.values?.[0]?.value;
				result[config.targetKey] = value === undefined ? null : JSON.stringify(value);
			} catch (error: any) {
				if (this.isInvalidFacebookPostMetricError(error)) {
					this.logUnsupportedFacebookPostMetric(config.metricName);
					continue;
				}

				result.errors.push(
					`${config.targetKey}: ${
						error?.response?.data?.error?.message ||
						error?.message ||
						'Unknown Facebook post insights error'
					}`
				);
			}
		}

		return result;
	}

	private isInvalidFacebookPostMetricError(error: any) {
		const message = String(
			error?.response?.data?.error?.message || error?.message || ''
		).toLowerCase();
		const code = Number(error?.response?.data?.error?.code);
		return code === 100 && message.includes('valid insights metric');
	}

	private logUnsupportedFacebookPostMetric(metricName: string) {
		if (this.unsupportedFacebookPostMetrics.has(metricName)) {
			return;
		}

		this.unsupportedFacebookPostMetrics.add(metricName);
		this.logger.warn(
			`Meta content ingest: Facebook post insight metric ${metricName} is not supported by the current Graph API response; skipping it.`
		);
	}

	private normalizeInstagramMediaTypeValue(mediaType?: string) {
		return String(mediaType || '').trim().toUpperCase() || 'UNKNOWN';
	}

	/**
	 * Core metrics every media type answers, plus optional ones that only some do
	 * (impressions is gone for newer media, the ig_reels_* pair only exists for Reels).
	 * Anything Meta has rejected for this media type in this process is left out, so a
	 * rejection costs one retry the first time and nothing after that.
	 */
	private buildInstagramMediaMetrics(mediaType: string) {
		const core = ['total_interactions', 'reach', 'saved', 'shares'];
		const optional = ['impressions'];
		if (mediaType === 'VIDEO' || mediaType === 'REELS') {
			core.push('views');
			optional.push('ig_reels_avg_watch_time', 'ig_reels_video_view_total_time');
		}
		return [...core, ...optional].filter(
			(metric) => !this.isInstagramMediaMetricUnsupported(mediaType, metric)
		);
	}

	/** Which of the requested metrics Meta's rejection names; falls back to every optional
	 * metric in the request when the message doesn't say, so the retry can still succeed. */
	private extractRejectedInstagramMetrics(error: any, requested: string[]) {
		const message = String(error?.response?.data?.error?.message || '').toLowerCase();
		const named = requested.filter((metric) => message.includes(metric.toLowerCase()));
		if (named.length) {
			return named;
		}
		const alwaysSafe = new Set(['total_interactions', 'reach', 'saved', 'shares', 'views']);
		return requested.filter((metric) => !alwaysSafe.has(metric));
	}

	private isInvalidInstagramMediaMetricError(error: any) {
		const message = String(
			error?.response?.data?.error?.message || error?.message || ''
		).toLowerCase();
		const code = Number(error?.response?.data?.error?.code);
		return code === 100 && (
			message.includes('valid insights metric')
			|| message.includes('not a valid insights metric')
			|| message.includes('does not support')
			|| message.includes('not available')
			|| (message.includes('metric') && (message.includes('support') || message.includes('available')))
		);
	}

	private isInstagramMediaMetricUnsupported(mediaType: string, metricName: string) {
		return this.unsupportedInstagramMediaMetricsByType.get(mediaType)?.has(metricName) ?? false;
	}

	private markInstagramMediaMetricUnsupported(mediaType: string, metricName: string) {
		const current = this.unsupportedInstagramMediaMetricsByType.get(mediaType) || new Set<string>();
		if (current.has(metricName)) {
			return;
		}

		current.add(metricName);
		this.unsupportedInstagramMediaMetricsByType.set(mediaType, current);
		this.logger.warn(
			`Meta content ingest: Instagram media insight metric ${metricName} is not supported for media type ${mediaType}; retrying without it.`
		);
	}

	/**
	 * Likes/comments/shares are now requested via field expansion on the posts-list call
	 * itself (see fetchFacebookPostRows) instead of three separate per-post API calls.
	 * `reactions.summary(true)` is used (not `likes.summary`) to preserve the original
	 * behavior of counting all reaction types (love/haha/wow/etc.), not just literal Likes.
	 */
	private extractFacebookPostCountsFromRow(row: {
		reactions?: { summary?: { total_count?: number } };
		comments?: { summary?: { total_count?: number } };
		shares?: { count?: number };
	}) {
		// `shares` is legitimately absent from Graph API whenever a post has zero shares
		// (documented, long-standing behavior) — that's not a data gap. `reactions`/`comments`
		// with `.summary(true)` requested, on the other hand, always come back with a
		// `summary.total_count` (0 if none) when the field is actually honored, so a fully
		// missing `reactions`/`comments` key most likely means the field-expansion request
		// silently dropped it (e.g. a permission/scope issue), which IS worth surfacing.
		return {
			likes: Number(row.reactions?.summary?.total_count ?? 0),
			comments: Number(row.comments?.summary?.total_count ?? 0),
			shares: Number(row.shares?.count ?? 0),
			reactionsFieldMissing: row.reactions === undefined,
			commentsFieldMissing: row.comments === undefined
		};
	}

	private async fetchInstagramMediaInsightRows(
		mediaId: string,
		accessToken: string,
		mediaType: string
	) {
		const mediaTypeValue = this.normalizeInstagramMediaTypeValue(mediaType);
		let lastError: any = null;

		// One retry per rejected metric set: each pass drops what Meta refused last time.
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const metrics = this.buildInstagramMediaMetrics(mediaTypeValue);
			try {
				const response = await this.metaApiService.get<{
					data?: Array<{ name?: string; values?: Array<{ value?: number | string | Record<string, any> }> }>;
				}>(`/${mediaId}/insights`, {
					accessToken,
					params: {
						metric: metrics.join(',')
					},
					endpointLabel: 'instagram_media_insights_content_snapshot'
				});
				return {
					rows: response.data || [],
					errors: [] as string[]
				};
			} catch (error: any) {
				lastError = error;
				if (!this.isInvalidInstagramMediaMetricError(error)) {
					break;
				}
				const rejected = this.extractRejectedInstagramMetrics(error, metrics);
				if (!rejected.length) {
					break;
				}
				for (const metric of rejected) {
					this.markInstagramMediaMetricUnsupported(mediaTypeValue, metric);
				}
			}
		}

		return {
			rows: [],
			errors: [
				`insights: ${
					lastError?.response?.data?.error?.message ||
					lastError?.message ||
					'Unknown Instagram media insights error'
				}`
			]
		};
	}

	private async ingestFacebookPageInsights(
		accessToken: string,
		pageId: string,
		pageName: string | null,
		startDate: string,
		endDate: string,
		options?: {
			includeGeoSnapshots?: boolean;
		}
	) {
		const warnings: string[] = [];
		let upserted = 0;
		const sinceTimestamp = Math.floor(new Date(`${startDate}T00:00:00.000Z`).getTime() / 1000);
		const untilTimestamp = Math.floor(new Date(`${endDate}T23:59:59.999Z`).getTime() / 1000);

		for (const config of this.facebookPageInsightMetricConfigs) {
			let resolvedRows: Array<{
				name?: string;
				period?: string;
				title?: string;
				description?: string;
				values?: Array<{ end_time?: string; value?: unknown }>;
			}> = [];
			let lastError: any = null;
			let resolved = false;

			for (const metricName of config.candidates) {
				try {
					const response = await this.metaApiService.get<{
						data?: Array<{
							name?: string;
							period?: string;
							title?: string;
							description?: string;
							values?: Array<{ end_time?: string; value?: unknown }>;
						}>;
					}>(`/${pageId}/insights`, {
						accessToken,
						params: {
							metric: metricName,
							period: config.period,
							...(config.period === 'day' ? { since: sinceTimestamp, until: untilTimestamp } : {})
						},
						endpointLabel: `facebook_page_insights_${config.metricKey}`
					});
					resolvedRows = response.data || [];
					resolved = true;
					break;
				} catch (error: any) {
					lastError = error;
					if (!this.isInvalidFacebookPostMetricError(error) && !this.isPermissionError(error)) {
						break;
					}
				}
			}

			const metricKey = `facebook.page_insights.${config.metricKey}`;
			if (!resolved) {
				const reason = this.getErrorMessage(lastError);
				await this.dataCoverageService.recordAttempt({
					platform: 'meta',
					jobType: 'profile_snapshot',
					metricKey,
					scope: pageId,
					success: false,
					status: this.isPermissionError(lastError)
						? 'unavailable_permission'
						: 'unavailable_unsupported',
					reason
				});
				warnings.push(`Facebook page insight ${config.metricKey} unavailable: ${reason}`);
				continue;
			}

			let metricUpserted = 0;
			for (const row of resolvedRows) {
				for (const valueRow of row.values || []) {
					await this.upsertFacebookPageInsightRow(pageId, row, valueRow);
					metricUpserted++;
				}
			}

			upserted += metricUpserted;
			await this.dataCoverageService.recordAttempt({
				platform: 'meta',
				jobType: 'profile_snapshot',
				metricKey,
				scope: pageId,
				success: true
			});

			if (!metricUpserted) {
				warnings.push(`Facebook page insight ${config.metricKey} returned no rows`);
			}
		}

		let geoRowsUpserted = 0;
		const includeGeoSnapshots = options?.includeGeoSnapshots ?? true;
		if (!includeGeoSnapshots) {
			warnings.push(
				'Facebook page audience geo snapshots were skipped for historical backfill because the Graph API only returns the current lifetime distribution, not true historical slices.'
			);
			return { upserted, geoRowsUpserted, warnings };
		}
		// page_fans_country/page_fans_city are always queried as period=lifetime (a live
		// snapshot of the current audience distribution, not a range-bound metric), so the
		// snapshot is only ever "for" today — regardless of what startDate/endDate the caller
		// requested (e.g. a historical geo_snapshot backfill). Labeling it with the caller's
		// range would fabricate fake historical rows that just repeat today's live value.
		const geoSnapshotDate = this.formatDate(new Date());
		for (const config of this.facebookPageGeoMetricConfigs) {
			let rows: Array<{ values?: Array<{ value?: unknown }> }> = [];
			let lastError: any = null;
			let resolved = false;

			for (const metricName of config.candidates) {
				try {
					const response = await this.metaApiService.get<{
						data?: Array<{ values?: Array<{ value?: unknown }> }>;
					}>(`/${pageId}/insights`, {
						accessToken,
						params: {
							metric: metricName,
							period: 'lifetime'
						},
						endpointLabel: `facebook_page_insights_${config.metricKey}`
					});
					rows = response.data || [];
					resolved = true;
					break;
				} catch (error: any) {
					lastError = error;
					if (!this.isInvalidFacebookPostMetricError(error) && !this.isPermissionError(error)) {
						break;
					}
				}
			}

			const metricKey = `facebook.audience_geo.${config.metricKey}`;
			if (!resolved) {
				const reason = this.getErrorMessage(lastError);
				await this.dataCoverageService.recordAttempt({
					platform: 'meta',
					jobType: 'geo_snapshot',
					metricKey,
					scope: pageId,
					success: false,
					status: this.isPermissionError(lastError)
						? 'unavailable_permission'
						: 'unavailable_unsupported',
					reason
				});
				warnings.push(`Facebook audience geo ${config.metricKey} unavailable: ${reason}`);
				continue;
			}

			let metricGeoRows = 0;
			for (const row of rows) {
				for (const valueRow of row.values || []) {
					const entries = this.extractFlatGeoEntries(valueRow?.value);
					for (const { geoKey, value } of entries) {
						const geoName = this.normalizeGeoName(geoKey, config.geoType);
						await this.upsertGeoLocation(config.geoType, geoKey, geoName);
						await this.upsertAudienceGeoStatRow({
							platform: 'facebook',
							assetId: pageId,
							assetTitle: pageName,
							geoType: config.geoType,
							geoKey,
							geoName,
							metric: 'followers',
							value: this.normalizeInsightValue(value) ?? 0,
							startDate: geoSnapshotDate,
							endDate: geoSnapshotDate,
							rawJson: JSON.stringify({ metric: config.metricKey, geoKey, value })
						});
						metricGeoRows++;
					}
				}
			}

			geoRowsUpserted += metricGeoRows;
			await this.dataCoverageService.recordAttempt({
				platform: 'meta',
				jobType: 'geo_snapshot',
				metricKey,
				scope: pageId,
				success: true
			});

			if (!metricGeoRows) {
				warnings.push(`Facebook audience geo ${config.metricKey} returned no usable entries`);
			}
		}

		return { upserted, geoRowsUpserted, warnings };
	}

	private isPermissionError(error: any) {
		const message = String(
			error?.response?.data?.error?.message || error?.message || ''
		).toLowerCase();
		const code = Number(error?.response?.data?.error?.code);
		return (
			code === 10 ||
			code === 200 ||
			message.includes('permission') ||
			message.includes('does not have sufficient') ||
			message.includes('access token does not have')
		);
	}

	private extractFlatGeoEntries(rawValue: unknown): Array<{ geoKey: string; value: unknown }> {
		if (!rawValue || typeof rawValue !== 'object') {
			return [];
		}

		return Object.entries(rawValue as Record<string, unknown>)
			.filter(([geoKey]) => Boolean(geoKey))
			.map(([geoKey, value]) => ({ geoKey, value }));
	}

	/**
	 * Account-level daily insights — the Professional-dashboard numbers. Two request shapes
	 * on the Graph API: `reach` and `follower_count` are time series (one value per day with
	 * an end_time), everything else is total_value-only and must be asked for one day at a
	 * time as [since=D, until=D+1). A trailing window is re-ingested each night so a day that
	 * was still partial when first seen is corrected on the next pass (rows upsert on
	 * account+metric+date).
	 */
	private async ingestInstagramAccountInsights(
		accessToken: string,
		instagramId: string,
		options?: {
			windowDays?: number;
			startDate?: string;
			endDate?: string;
		}
	) {
		const warnings: string[] = [];
		let upserted = 0;
		const days = this.resolveInstagramAccountInsightDays(options);
		const followerCountDays = this.filterFollowerCountEligibleDays(days);
		const dayAfter = (day: string) => {
			const d = new Date(`${day}T00:00:00.000Z`);
			d.setUTCDate(d.getUTCDate() + 1);
			return this.formatDate(d);
		};
		const timeseriesWindows = this.chunkDateRangeDays(days, 30);

		// `reach` has ~2 years of history, while `follower_count` is only available for the
		// last 30 days excluding today. Query them separately so a historical backfill still
		// repairs `reach` even when follower_count is outside Meta's shorter retention window.
		try {
			for (const window of timeseriesWindows) {
				const response = await this.metaApiService.get<{
					data?: Array<{ name?: string; values?: Array<{ end_time?: string; value?: unknown }> }>;
				}>(`/${instagramId}/insights`, {
					accessToken,
					params: {
						metric: 'reach',
						period: 'day',
						since: window[0],
						until: dayAfter(window[window.length - 1])
					},
					endpointLabel: 'instagram_account_insights_reach_timeseries'
				});
				for (const row of response.data || []) {
					for (const valueRow of row.values || []) {
						if (!row.name || !valueRow.end_time) continue;
						// end_time is the end of the day in the account's timezone, i.e. the
						// following calendar day's early hours in UTC — the day itself is 24h before.
						const endTime = new Date(valueRow.end_time);
						const dayDate = new Date(endTime.getTime() - 24 * 60 * 60 * 1000);
						upserted += await this.upsertInstagramAccountInsightRow({
							instagramId,
							metric: row.name,
							date: this.formatDate(dayDate),
							value: this.normalizeInsightValue(valueRow.value) ?? 0,
							endTime
						});
					}
				}
			}
			await this.dataCoverageService.recordAttempt({
				platform: 'meta',
				jobType: 'profile_snapshot',
				metricKey: 'instagram.account_insights.reach_timeseries',
				scope: instagramId,
				success: true
			});
		} catch (error: any) {
			const reason = this.getErrorMessage(error);
			warnings.push(`Instagram account reach insights skipped: ${reason}`);
			await this.dataCoverageService.recordAttempt({
				platform: 'meta',
				jobType: 'profile_snapshot',
				metricKey: 'instagram.account_insights.reach_timeseries',
				scope: instagramId,
				success: false,
				status: this.isPermissionError(error) ? 'unavailable_permission' : 'unavailable_error',
				reason
			});
		}

		if (followerCountDays.length) {
			try {
				const response = await this.metaApiService.get<{
					data?: Array<{ name?: string; values?: Array<{ end_time?: string; value?: unknown }> }>;
				}>(`/${instagramId}/insights`, {
					accessToken,
					params: {
						metric: 'follower_count',
						period: 'day',
						since: followerCountDays[0],
						until: dayAfter(followerCountDays[followerCountDays.length - 1])
					},
					endpointLabel: 'instagram_account_insights_follower_timeseries'
				});
				for (const row of response.data || []) {
					for (const valueRow of row.values || []) {
						if (!row.name || !valueRow.end_time) continue;
						const endTime = new Date(valueRow.end_time);
						const dayDate = new Date(endTime.getTime() - 24 * 60 * 60 * 1000);
						upserted += await this.upsertInstagramAccountInsightRow({
							instagramId,
							metric: row.name,
							date: this.formatDate(dayDate),
							value: this.normalizeInsightValue(valueRow.value) ?? 0,
							endTime
						});
					}
				}
				await this.dataCoverageService.recordAttempt({
					platform: 'meta',
					jobType: 'profile_snapshot',
					metricKey: 'instagram.account_insights.follower_timeseries',
					scope: instagramId,
					success: true
				});
			} catch (error: any) {
				const reason = this.getErrorMessage(error);
				warnings.push(`Instagram follower-count insights skipped: ${reason}`);
				await this.dataCoverageService.recordAttempt({
					platform: 'meta',
					jobType: 'profile_snapshot',
					metricKey: 'instagram.account_insights.follower_timeseries',
					scope: instagramId,
					success: false,
					status: this.isPermissionError(error) ? 'unavailable_permission' : 'unavailable_error',
					reason
				});
			}
		}

		if (followerCountDays.length !== days.length) {
			warnings.push(
				'Instagram follower_count is only available for the last 30 days excluding the current day, so older days in this backfill were skipped for that metric.'
			);
		}

		// total_value metrics: one call per day in the window, run with bounded
		// concurrency since each day's request is independent of the others.
		const totalValueMetrics = [
			'profile_views', 'website_clicks', 'accounts_engaged', 'total_interactions',
			'views', 'likes', 'comments', 'shares', 'saves', 'replies'
		];
		const fetchTotalValueDay = async (day: string) => {
			try {
				const response = await this.metaApiService.get<{
					data?: Array<{ name?: string; total_value?: { value?: unknown } }>;
				}>(`/${instagramId}/insights`, {
					accessToken,
					params: {
						metric: totalValueMetrics.join(','),
						metric_type: 'total_value',
						period: 'day',
						since: day,
						until: dayAfter(day)
					},
					endpointLabel: 'instagram_account_insights_total_value'
				});
				let dayUpserted = 0;
				for (const row of response.data || []) {
					if (!row.name) continue;
					dayUpserted += await this.upsertInstagramAccountInsightRow({
						instagramId,
						metric: row.name,
						date: day,
						value: this.normalizeInsightValue(row.total_value?.value) ?? 0,
						endTime: null
					});
				}
				upserted += dayUpserted;
				await this.dataCoverageService.recordAttempt({
					platform: 'meta',
					jobType: 'profile_snapshot',
					metricKey: 'instagram.account_insights.daily_totals',
					scope: instagramId,
					success: true
				});
			} catch (error: any) {
				const reason = this.getErrorMessage(error);
				warnings.push(`Instagram account insights for ${day} skipped: ${reason}`);
				await this.dataCoverageService.recordAttempt({
					platform: 'meta',
					jobType: 'profile_snapshot',
					metricKey: 'instagram.account_insights.daily_totals',
					scope: instagramId,
					success: false,
					status: this.isPermissionError(error) ? 'unavailable_permission' : 'unavailable_error',
					reason
				});
			}
		};
		const totalValueConcurrency = 5;
		for (let index = 0; index < days.length; index += totalValueConcurrency) {
			await Promise.all(days.slice(index, index + totalValueConcurrency).map(fetchTotalValueDay));
		}

		return { upserted, days, warnings };
	}

	private filterFollowerCountEligibleDays(days: string[]) {
		if (!days.length) {
			return [];
		}

		const latestAllowed = new Date();
		latestAllowed.setUTCHours(0, 0, 0, 0);
		latestAllowed.setUTCDate(latestAllowed.getUTCDate() - 1);

		const earliestAllowed = new Date(latestAllowed);
		earliestAllowed.setUTCDate(earliestAllowed.getUTCDate() - 29);

		return days.filter((day) => {
			const date = new Date(`${day}T00:00:00.000Z`);
			return date.getTime() >= earliestAllowed.getTime() && date.getTime() <= latestAllowed.getTime();
		});
	}

	private chunkDateRangeDays(days: string[], maxDaysPerChunk: number) {
		if (!days.length) {
			return [];
		}

		const chunkSize = Math.max(1, Math.floor(maxDaysPerChunk));
		const chunks: string[][] = [];
		for (let index = 0; index < days.length; index += chunkSize) {
			chunks.push(days.slice(index, index + chunkSize));
		}
		return chunks;
	}

	private async upsertInstagramAccountInsightRow(payload: {
		instagramId: string;
		metric: string;
		date: string;
		value: number;
		endTime: Date | null;
	}) {
		const rowPayload = {
			...payload,
			value: String(Math.round(payload.value)),
			fetchedAt: new Date()
		};
		const existing = await this.metaInstagramAccountInsightsRepo.findOne({
			where: { instagramId: payload.instagramId, metric: payload.metric, date: payload.date }
		});
		if (existing) {
			await existing.update(rowPayload);
		} else {
			await this.metaInstagramAccountInsightsRepo.create(rowPayload);
		}
		return 1;
	}

	private async ingestInstagramAudienceGeo(
		accessToken: string,
		instagramId: string,
		username: string | null,
		startDate: string,
		endDate: string
	) {
		const warnings: string[] = [];
		let geoRowsUpserted = 0;
		let demographicRowsUpserted = 0;
		const geoBreakdowns = new Set(['country', 'city']);
		const demographicBreakdowns = new Set(['age', 'gender', 'age,gender']);
		const metricConfigs = [
			{
				metric: 'follower_demographics',
				storedMetric: 'followers',
				breakdowns: ['country', 'city', 'age', 'gender', 'age,gender']
			},
			{
				metric: 'engaged_audience_demographics',
				storedMetric: 'engaged_audience',
				breakdowns: ['country', 'city', 'age', 'gender'],
				// Graph v20+ accepts only this_month and this_week for engaged/reached audience
				// demographics (last_30_days / prev_month / last_14_days are rejected with #100).
				// this_month is the figure the dashboard labels, so it goes first; the timeframe
				// that answered is stored in each row's rawJson.
				timeframes: ['this_month', 'this_week']
			},
			{
				metric: 'reached_audience_demographics',
				storedMetric: 'reached_audience',
				breakdowns: ['country', 'city', 'age', 'gender'],
				timeframes: ['this_month', 'this_week']
			}
		];

		for (const config of metricConfigs) {
			for (const breakdown of config.breakdowns) {
				const isGeoBreakdown = geoBreakdowns.has(breakdown);
				const isDemographicBreakdown = demographicBreakdowns.has(breakdown);
				const metricKey = isGeoBreakdown
					? `instagram.audience_geo.${config.storedMetric}.${breakdown}`
					: `instagram.audience_demographics.${config.storedMetric}.${breakdown.replace(',', '_')}`;
				const jobType = isGeoBreakdown ? 'geo_snapshot' : 'profile_snapshot';

				try {
					const audienceInsight = await this.fetchInstagramAudienceInsightRows(
						accessToken,
						instagramId,
						config.metric,
						breakdown,
						config.timeframes
					);
					if (!audienceInsight.rows.length) {
						warnings.push(
							`Instagram audience insight ${config.metric} (${breakdown}) returned no rows from Meta`
						);
						await this.dataCoverageService.recordAttempt({
							platform: 'meta',
							jobType,
							metricKey,
							scope: instagramId,
							success: false,
							status: 'unavailable_insufficient_data',
							reason: 'Meta returned no rows for this breakdown (often below the audience-size reporting threshold)'
						});
						continue;
					}

					let metricRowsUpserted = 0;

					for (const row of audienceInsight.rows) {
						const candidateValues = Array.isArray(row.values) && row.values.length
							? row.values.map((valueRow) => valueRow?.value)
							: [row.total_value];
						for (const candidateValue of candidateValues) {
							const entries = this.extractInstagramGeoEntries(candidateValue, breakdown);
							for (const { geoType, geoKey, value } of entries) {
								if (!geoKey) {
									continue;
								}

								if (isGeoBreakdown) {
									if (geoType !== 'country' && geoType !== 'city') {
										continue;
									}
									const geoName = this.normalizeGeoName(geoKey, geoType);
									await this.upsertGeoLocation(geoType, geoKey, geoName);
									await this.upsertAudienceGeoStatRow({
										platform: 'instagram',
										assetId: instagramId,
										assetTitle: username,
										geoType,
										geoKey,
										geoName,
										metric: config.storedMetric,
										// `value` is a BIGINT NOT NULL and the upsert stringifies it, so an
										// unparseable entry must fall back to 0 here — String(null) is the
										// literal "null", which Postgres rejects for the whole breakdown.
										value: this.normalizeInsightValue(value) ?? 0,
										startDate,
										endDate,
										rawJson: JSON.stringify({
											metric: config.metric,
											storedMetric: config.storedMetric,
											breakdown,
											timeframe: audienceInsight.timeframe ?? null,
											geoKey,
											value
										})
									});
									geoRowsUpserted++;
								} else if (isDemographicBreakdown) {
									await this.upsertAudienceDemographicStatRow({
										platform: 'instagram',
										assetId: instagramId,
										assetTitle: username,
										dimension: breakdown,
										dimensionKey: geoKey,
										dimensionLabel: this.normalizeGeoName(geoKey, 'demographic'),
										metric: config.storedMetric,
										value: this.normalizeInsightValue(value) ?? 0,
										startDate,
										endDate,
										rawJson: JSON.stringify({
											metric: config.metric,
											storedMetric: config.storedMetric,
											breakdown,
											timeframe: audienceInsight.timeframe ?? null,
											dimensionKey: geoKey,
											value
										})
									});
									demographicRowsUpserted++;
								} else {
									continue;
								}
								metricRowsUpserted++;
							}
						}
					}

					if (!metricRowsUpserted) {
						const timeframeLabel = audienceInsight.timeframe
							? ` using timeframe ${audienceInsight.timeframe}`
							: '';
						warnings.push(
							`Instagram audience insight ${config.metric} (${breakdown}) returned no usable demographic entries${timeframeLabel}`
						);
						await this.dataCoverageService.recordAttempt({
							platform: 'meta',
							jobType,
							metricKey,
							scope: instagramId,
							success: false,
							status: 'unavailable_insufficient_data',
							reason: `Meta returned rows but none contained usable ${breakdown} entries`
						});
					} else {
						await this.dataCoverageService.recordAttempt({
							platform: 'meta',
							jobType,
							metricKey,
							scope: instagramId,
							success: true
						});
					}
				} catch (error: any) {
					const reason =
						error?.response?.data?.error?.message ||
						error?.message ||
						'Unknown Instagram audience insight error';
					warnings.push(
						`Instagram audience insight ${config.metric} (${breakdown}) skipped: ${reason}`
					);
					await this.dataCoverageService.recordAttempt({
						platform: 'meta',
						jobType,
						metricKey,
						scope: instagramId,
						success: false,
						status: this.isPermissionError(error)
							? 'unavailable_permission'
							: 'unavailable_unsupported',
						reason
					});
				}
			}
		}

		return { geoRowsUpserted, demographicRowsUpserted, warnings };
	}

	private async fetchInstagramAudienceInsightRows(
		accessToken: string,
		instagramId: string,
		metric: string,
		breakdown: string,
		timeframes?: string[]
	) {
		const candidateTimeframes = timeframes?.length ? timeframes : [null];
		let lastError: any = null;
		let lastEmpty: { rows: any[]; timeframe: string | null } | null = null;

		for (const timeframe of candidateTimeframes) {
			try {
				const response = await this.metaApiService.get<{
					data?: Array<{
						name?: string;
						period?: string;
						total_value?: Record<string, any>;
						values?: Array<{ end_time?: string; value?: number | string | Record<string, any> }>;
					}>;
				}>(`/${instagramId}/insights`, {
					accessToken,
					params: {
						metric,
						metric_type: 'total_value',
						breakdown,
						period: 'lifetime',
						...(timeframe ? { timeframe } : {})
					},
					endpointLabel: `instagram_audience_${metric}_${breakdown}${timeframe ? `_${timeframe}` : ''}`
				});

				const rows = response.data || [];
				// Meta answers a too-thin timeframe with the breakdown *shape* but no entries
				// (engaged_audience for "this_month" early in the month, or under its
				// reporting threshold). That is not an error, so it never used to move on to
				// the next candidate — try the wider timeframes before calling it empty.
				if (this.instagramInsightRowsHaveEntries(rows, breakdown)) {
					return { rows, timeframe };
				}
				lastEmpty = { rows, timeframe };
			} catch (error: any) {
				lastError = error;
			}
		}

		if (lastEmpty) {
			return lastEmpty;
		}
		throw lastError;
	}

	private instagramInsightRowsHaveEntries(
		rows: Array<{ total_value?: Record<string, any>; values?: Array<{ value?: unknown }> }>,
		breakdown: string
	) {
		return rows.some((row) => {
			const candidateValues = Array.isArray(row.values) && row.values.length
				? row.values.map((valueRow) => valueRow?.value)
				: [row.total_value];
			return candidateValues.some(
				(value) => this.extractInstagramGeoEntries(value, breakdown).length > 0
			);
		});
	}

	private extractInstagramGeoEntries(rawValue: unknown, fallbackGeoType?: string) {
		const entries: Array<{ geoType: string; geoKey: string; value: unknown }> = [];
		if (!rawValue || typeof rawValue !== 'object') {
			return entries;
		}

		const typedValue = rawValue as Record<string, unknown>;
		const breakdowns = Array.isArray(typedValue.breakdowns)
			? typedValue.breakdowns
			: [];
		for (const breakdownRow of breakdowns) {
			if (!breakdownRow || typeof breakdownRow !== 'object') {
				continue;
			}

			const typedBreakdown = breakdownRow as Record<string, unknown>;
			const dimensionKeys = Array.isArray(typedBreakdown.dimension_keys)
				? typedBreakdown.dimension_keys
				: Array.isArray(typedBreakdown.dimensionKeys)
					? typedBreakdown.dimensionKeys
					: [];
			const breakdownGeoType =
				this.inferInstagramGeoTypeFromBreakdownKeys(dimensionKeys) ||
				fallbackGeoType ||
				'city';
			const results = Array.isArray(typedBreakdown.results)
				? typedBreakdown.results
				: [];
			for (const resultRow of results) {
				if (!resultRow || typeof resultRow !== 'object') {
					continue;
				}

				const typedResult = resultRow as Record<string, unknown>;
				const dimensionValues = Array.isArray(typedResult.dimension_values)
					? typedResult.dimension_values
					: Array.isArray(typedResult.dimensionValues)
						? typedResult.dimensionValues
						: [];
				const geoKey = String(
					dimensionValues.find((value) => value !== null && value !== undefined) ||
					typedResult.name ||
					typedResult.key ||
					''
				).trim();
				if (!geoKey) {
					continue;
				}

				entries.push({
					geoType: this.inferGeoTypeFromKey(geoKey, breakdownGeoType),
					geoKey,
					value:
						typedResult.value ??
						typedResult.total_value ??
						typedResult.count ??
						0
				});
			}
		}

		// Once Meta has answered in the structured breakdowns shape, an empty result set is
		// the answer — falling through to the flat-map parser below would walk the
		// `breakdowns` array itself and emit its indices ("0") as country keys.
		if (entries.length || Array.isArray(typedValue.breakdowns)) {
			return entries;
		}

		for (const [topLevelKey, topLevelValue] of Object.entries(typedValue)) {
			if (!topLevelValue || typeof topLevelValue !== 'object' || Array.isArray(topLevelValue)) {
				continue;
			}

			const normalizedTopLevelKey = String(topLevelKey || '').toLowerCase();
			const inferredGeoType =
				normalizedTopLevelKey.includes('country')
					? 'country'
					: normalizedTopLevelKey.includes('city')
						? 'city'
						: fallbackGeoType || null;

			for (const [nestedKey, nestedValue] of Object.entries(
				topLevelValue as Record<string, unknown>
			)) {
				entries.push({
					geoType: this.inferGeoTypeFromKey(nestedKey, inferredGeoType || undefined),
					geoKey: nestedKey,
					value: nestedValue
				});
			}
		}

		return entries;
	}

	private inferInstagramGeoTypeFromBreakdownKeys(values: unknown[]) {
		for (const value of values) {
			const normalizedValue = String(value || '').toLowerCase();
			if (normalizedValue === 'country' || normalizedValue.includes('country')) {
				return 'country';
			}
			if (normalizedValue === 'city' || normalizedValue.includes('city')) {
				return 'city';
			}
		}
		return null;
	}

	private inferGeoTypeFromKey(value: string, fallbackGeoType?: string) {
		const key = String(value || '');
		if (/^[A-Z]{2}$/.test(key)) {
			return 'country';
		}
		return fallbackGeoType || 'city';
	}

	private async upsertFacebookPageInsightRow(
		pageId: string,
		row: {
			name?: string;
			period?: string;
			title?: string;
			description?: string;
		},
		valueRow: { end_time?: string; value?: number | string | Record<string, any> }
	) {
		const payload = {
			pageId,
			metric: row.name ?? '',
			period: row.period ?? null,
			endTime: valueRow.end_time ? new Date(valueRow.end_time) : null,
			value: valueRow.value === undefined ? null : JSON.stringify(valueRow.value),
			title: row.title ?? null,
			description: row.description ?? null,
			rawJson: JSON.stringify({
				metric: row.name ?? null,
				period: row.period ?? null,
				end_time: valueRow.end_time ?? null,
				value: valueRow.value ?? null
			})
		};

		const existing = await this.metaFacebookPageInsightsRepo.findOne({
			where: {
				pageId: payload.pageId,
				metric: payload.metric,
				period: payload.period,
				endTime: payload.endTime
			}
		});

		if (existing) {
			await existing.update(payload);
			return existing;
		}

		return await this.metaFacebookPageInsightsRepo.create(payload);
	}

	private async upsertInstagramMediaInsightRows(
		mediaId: string,
		instagramId: string,
		rows: Array<{ name?: string; period?: string; values?: Array<{ end_time?: string; value?: unknown }> }>
	) {
		for (const row of rows) {
			for (const valueRow of row.values || []) {
				const payload = {
					mediaId,
					instagramId,
					metric: row.name ?? '',
					period: row.period ?? null,
					endTime: valueRow.end_time ? new Date(valueRow.end_time) : null,
					value:
						valueRow.value === undefined ? null : JSON.stringify(valueRow.value),
					rawJson: JSON.stringify({
						metric: row.name ?? null,
						period: row.period ?? null,
						end_time: valueRow.end_time ?? null,
						value: valueRow.value ?? null
					})
				};

				const existing = await this.metaInstagramMediaInsightsRepo.findOne({
					where: {
						mediaId: payload.mediaId,
						instagramId: payload.instagramId,
						metric: payload.metric,
						period: payload.period,
						endTime: payload.endTime
					}
				});

				if (existing) {
					await existing.update(payload);
				} else {
					await this.metaInstagramMediaInsightsRepo.create(payload);
				}
			}
		}
	}

	private async upsertContentMetricSnapshot(payload: {
		platform: 'facebook' | 'instagram';
		assetType: string;
		assetId: string;
		accountId: string;
		likes: number | null;
		comments: number | null;
		shares: number | null;
		saved: number | null;
		reach: number | null;
		impressions: number | null;
		engagement: number | null;
		interactions: number | null;
		views: number | null;
		engagementSource: string | null;
		rawJson: string | null;
	}) {
		const snapshotDate = this.formatDate(new Date());
		const rowPayload = {
			platform: payload.platform,
			assetType: payload.assetType,
			assetId: payload.assetId,
			accountId: payload.accountId,
			snapshotDate,
			likes: this.toStringOrNull(payload.likes),
			comments: this.toStringOrNull(payload.comments),
			shares: this.toStringOrNull(payload.shares),
			saved: this.toStringOrNull(payload.saved),
			reach: this.toStringOrNull(payload.reach),
			impressions: this.toStringOrNull(payload.impressions),
			engagement: this.toStringOrNull(payload.engagement),
			interactions: this.toStringOrNull(payload.interactions),
			views: this.toStringOrNull(payload.views),
			engagementSource: payload.engagementSource,
			fetchedAt: new Date(),
			// The full Graph payload already lives on the post/media row and no read path
			// ever looks at it here; copying it into every daily snapshot was ~90% of this
			// table's size (260 MB of 292 MB) for nothing.
			rawJson: null
		};

		const existing = await this.metaContentMetricSnapshotsRepo.findOne({
			where: {
				platform: rowPayload.platform,
				assetId: rowPayload.assetId,
				snapshotDate: rowPayload.snapshotDate
			}
		});

		if (existing) {
			await existing.update(rowPayload);
			return existing;
		}

		return await this.metaContentMetricSnapshotsRepo.create(rowPayload);
	}

	private async backfillLegacyAudienceGeoRows() {
		const existingAudienceRows = await this.metaAudienceGeoStatsRepo.count();
		if (existingAudienceRows > 0) {
			return;
		}

		const legacyRows = await this.metaVideoGeoStatsRepo.findAll({
			where: {
				assetType: 'profile',
				metric: {
					[Op.in]: ['followers', 'engaged_audience', 'reached_audience']
				}
			},
			raw: true
		});
		if (!legacyRows.length) {
			return;
		}

		for (const row of legacyRows) {
			await this.upsertAudienceGeoStatRow({
				platform: row.platform,
				assetId: row.assetId,
				assetTitle: row.assetTitle,
				geoType: row.geoType,
				geoKey: row.geoKey,
				geoName: row.geoName,
				metric: row.metric,
				value: Number(row.value ?? 0),
				startDate: row.startDate,
				endDate: row.endDate,
				rawJson: row.rawJson
			});
		}

		this.logger.log(`Backfilled ${legacyRows.length} legacy Meta audience geo rows into MetaAudienceGeoStats`);
	}

	private async upsertAudienceGeoStatRow(payload: {
		platform: string;
		assetId: string;
		assetTitle: string | null;
		geoType: string;
		geoKey: string;
		geoName: string;
		metric: string;
		value: number;
		startDate: string;
		endDate: string;
		rawJson: string;
	}) {
		const supportedMetrics = new Set(['followers', 'engaged_audience', 'reached_audience']);
		if (!supportedMetrics.has(String(payload.metric || '').toLowerCase())) {
			throw new BadGatewayException(
				`Unsupported Meta audience geo metric "${payload.metric}". Only followers, engaged_audience and reached_audience are supported for organic audience geo.`
			);
		}

		const existing = await this.metaAudienceGeoStatsRepo.findOne({
			where: {
				platform: payload.platform,
				assetId: payload.assetId,
				geoType: payload.geoType,
				geoKey: payload.geoKey,
				metric: payload.metric,
				startDate: payload.startDate,
				endDate: payload.endDate
			}
		});

		const rowPayload = {
			...payload,
			value: String(payload.value),
			fetchedAt: new Date()
		};

		if (existing) {
			await existing.update(rowPayload);
			return existing;
		}

		return await this.metaAudienceGeoStatsRepo.create(rowPayload);
	}

	private async upsertVideoGeoStatRow(payload: {
		platform: string;
		assetType: string;
		assetId: string;
		assetTitle: string | null;
		geoType: string;
		geoKey: string;
		geoName: string;
		metric: string;
		value: number;
		startDate: string;
		endDate: string;
		rawJson: string;
	}) {
		const existing = await this.metaVideoGeoStatsRepo.findOne({
			where: {
				platform: payload.platform,
				assetId: payload.assetId,
				geoType: payload.geoType,
				geoKey: payload.geoKey,
				metric: payload.metric,
				startDate: payload.startDate,
				endDate: payload.endDate
			}
		});

		const rowPayload = {
			...payload,
			value: String(payload.value),
			fetchedAt: new Date()
		};

		if (existing) {
			await existing.update(rowPayload);
			return existing;
		}

		return await this.metaVideoGeoStatsRepo.create(rowPayload);
	}

	private async upsertAudienceDemographicStatRow(payload: {
		platform: string;
		assetId: string;
		assetTitle: string | null;
		dimension: string;
		dimensionKey: string;
		dimensionLabel: string | null;
		metric: string;
		value: number;
		startDate: string;
		endDate: string;
		rawJson: string;
	}) {
		const existing = await this.metaAudienceDemographicStatsRepo.findOne({
			where: {
				platform: payload.platform,
				assetId: payload.assetId,
				dimension: payload.dimension,
				dimensionKey: payload.dimensionKey,
				metric: payload.metric,
				startDate: payload.startDate,
				endDate: payload.endDate
			}
		});

		const rowPayload = {
			...payload,
			value: String(payload.value),
			fetchedAt: new Date()
		};

		if (existing) {
			await existing.update(rowPayload);
			return existing;
		}

		return await this.metaAudienceDemographicStatsRepo.create(rowPayload);
	}

	/**
	 * Meta has deprecated most granular per-post/per-video geographic breakdown metrics
	 * for organic Page content in recent Graph API versions. These candidate metric names
	 * are the last known ones that could return this data; whether they still work depends
	 * on the app's API version and permissions. If neither resolves, this records a single
	 * coverage gap (not one per post) rather than silently leaving MetaVideoGeoStats empty.
	 */
	private async attemptFacebookPostVideoGeoBreakdown(
		postId: string,
		pageId: string,
		postTitle: string | null,
		accessToken: string,
		startDate: string,
		endDate: string
	) {
		if (this.facebookVideoGeoGapRecordedByPageId.has(pageId)) {
			return 0;
		}

		const candidates = [
			'post_video_view_time_by_country_id',
			'post_video_view_time_by_region_id'
		];
		let resolved = false;
		let lastError: any = null;
		let rows: Array<{ name?: string; values?: Array<{ value?: unknown }> }> = [];

		for (const metricName of candidates) {
			try {
				const response = await this.metaApiService.get<{
					data?: Array<{ name?: string; values?: Array<{ value?: unknown }> }>;
				}>(`/${postId}/insights`, {
					accessToken,
					params: { metric: metricName },
					endpointLabel: 'facebook_post_video_geo_breakdown'
				});
				rows = response.data || [];
				resolved = true;
				break;
			} catch (error: any) {
				lastError = error;
				if (!this.isInvalidFacebookPostMetricError(error) && !this.isPermissionError(error)) {
					break;
				}
			}
		}

		if (!resolved) {
			await this.recordFacebookVideoGeoGapOnce(pageId, this.getErrorMessage(lastError));
			return 0;
		}

		let upserted = 0;
		const geoType = 'country';
		for (const row of rows) {
			for (const valueRow of row.values || []) {
				const entries = this.extractFlatGeoEntries(valueRow?.value);
				for (const { geoKey, value } of entries) {
					const geoName = this.normalizeGeoName(geoKey, geoType);
					await this.upsertGeoLocation(geoType, geoKey, geoName);
					await this.upsertVideoGeoStatRow({
						platform: 'facebook',
						assetType: 'video',
						assetId: postId,
						assetTitle: postTitle,
						geoType,
						geoKey,
						geoName,
						metric: 'views',
						value: this.normalizeInsightValue(value) ?? 0,
						startDate,
						endDate,
						rawJson: JSON.stringify({ metric: row.name ?? null, geoKey, value })
					});
					upserted++;
				}
			}
		}

		await this.dataCoverageService.recordAttempt({
			platform: 'meta',
			jobType: 'content_snapshot',
			metricKey: 'meta.video_geo.facebook_post',
			scope: pageId,
			success: true
		});

		return upserted;
	}

	private async recordFacebookVideoGeoGapOnce(pageId: string, reason: string) {
		if (this.facebookVideoGeoGapRecordedByPageId.has(pageId)) {
			return;
		}
		this.facebookVideoGeoGapRecordedByPageId.add(pageId);
		await this.dataCoverageService.recordAttempt({
			platform: 'meta',
			jobType: 'content_snapshot',
			metricKey: 'meta.video_geo.facebook_post',
			scope: pageId,
			success: false,
			status: 'unavailable_unsupported',
			reason: `Per-post video geographic breakdown is not available from the Graph API for this app/token (${reason}). MetaVideoGeoStats will stay empty for new content until Meta exposes this again.`
		});
	}

	private async recordFacebookPostCountsFieldGapOnce(
		pageId: string,
		counts: { reactionsFieldMissing: boolean; commentsFieldMissing: boolean }
	) {
		if (this.facebookPostCountsFieldGapRecordedByPageId.has(pageId)) {
			return;
		}
		this.facebookPostCountsFieldGapRecordedByPageId.add(pageId);
		const missingFields = [
			counts.reactionsFieldMissing ? 'reactions' : null,
			counts.commentsFieldMissing ? 'comments' : null
		].filter(Boolean);
		await this.dataCoverageService.recordAttempt({
			platform: 'meta',
			jobType: 'content_snapshot',
			metricKey: 'meta.facebook_post.counts_field_expansion',
			scope: pageId,
			success: false,
			status: 'unavailable_permission',
			reason: `Graph API's posts-list response is missing the ${missingFields.join('/')} field entirely for this page/token — likes/comments are silently reading as 0 for affected posts instead of erroring. Usually a missing insights permission scope on the page token.`
		});
	}

	private async upsertGeoLocation(
		geoType: string,
		geoKey: string,
		geoName: string
	) {
		const existing = await this.metaGeoLocationsRepo.findOne({
			where: {
				geoType,
				geoKey
			}
		});

		const coordinates = await this.resolveGeoCoordinates(geoType, geoKey);
		const payload = {
			geoType,
			geoKey,
			geoName,
			countryCode:
				geoType === 'country' ? geoKey : coordinates?.countryCode ?? existing?.countryCode ?? null,
			latitude: coordinates?.latitude ?? null,
			longitude: coordinates?.longitude ?? null
		};

		if (existing) {
			await existing.update(payload);
			return existing;
		}

		return await this.metaGeoLocationsRepo.create(payload);
	}

	/**
	 * Some legacy Graph API metrics (e.g. post_video_view_time_by_country_id) return
	 * geo keys as "COUNTRY NAME (XX)" instead of a bare ISO-2 code. CountryList is
	 * keyed on the bare code, so pull the code out of that trailing "(XX)" when present.
	 */
	private extractCountryCode(geoKey: string): string {
		const raw = String(geoKey || '').trim().toUpperCase();
		const parenMatch = raw.match(/\(([A-Z]{2})\)\s*$/);
		return parenMatch ? parenMatch[1] : raw;
	}

	private async resolveGeoCoordinates(
		geoType: string,
		geoKey: string
	): Promise<{ latitude: string; longitude: string; countryCode?: string } | null> {
		if (geoType === 'city') {
			return await this.resolveCityCoordinates(geoKey);
		}
		if (geoType !== 'country') {
			return null;
		}

		const normalizedCode = this.extractCountryCode(geoKey);
		if (!normalizedCode) {
			return null;
		}

		const countryRow = await this.countryListRepo.findOne({
			where: { countryCode: normalizedCode },
			raw: true
		});

		if (!countryRow || countryRow.latitude === null || countryRow.longitude === null) {
			await this.dataCoverageService.recordAttempt({
				platform: 'meta',
				jobType: 'geo_snapshot',
				metricKey: 'meta.geo.country_coordinates',
				scope: normalizedCode,
				success: false,
				status: 'unavailable_unsupported',
				reason: `No coordinates found in CountryList for country code ${normalizedCode}`
			});
			return null;
		}

		await this.dataCoverageService.recordAttempt({
			platform: 'meta',
			jobType: 'geo_snapshot',
			metricKey: 'meta.geo.country_coordinates',
			scope: normalizedCode,
			success: true
		});

		return {
			latitude: countryRow.latitude,
			longitude: countryRow.longitude
		};
	}

	/**
	 * Platforms report audience cities as "City, Region" ("Hama, Hama Governorate",
	 * "6 October City, Giza Governorate") with no country. CityList (GeoNames cities15000)
	 * is matched on the normalised city name, falling back to GeoNames' alternate
	 * spellings; same-named cities are disambiguated by the region string against the
	 * admin1 name, then by population. The country comes back with the match, so city
	 * rows in MetaGeoLocations get one too.
	 */
	private async resolveCityCoordinates(geoKey: string) {
		const [cityPart, ...regionParts] = String(geoKey || '').split(',');
		const cityKey = this.toGazetteerNameKey(cityPart);
		const regionKey = this.toGazetteerNameKey(regionParts.join(' '));
		// A key with no letters ("0", "") is a parsing artefact, not a city; a gazetteer
		// alternate-name hit on it would be a coincidence, not a match.
		if (!cityKey || !/[a-z]/.test(cityKey)) {
			return null;
		}

		if (this.cityListSeeded === null) {
			this.cityListSeeded = (await this.cityListRepo.count()) > 0;
		}
		if (!this.cityListSeeded) {
			await this.dataCoverageService.recordAttempt({
				platform: 'meta',
				jobType: 'geo_snapshot',
				metricKey: 'meta.geo.city_coordinates',
				scope: null,
				success: false,
				status: 'unavailable_unsupported',
				reason: 'CityList is empty; seed it with tools/migration/import-geonames-cities.js so cities can be plotted on a map.'
			});
			return null;
		}

		let candidates = (await this.cityListRepo.findAll({
			where: { nameKey: cityKey },
			raw: true
		})) as any[];
		if (!candidates.length) {
			candidates = (await this.cityListRepo.findAll({
				where: { alternateNames: { [Op.like]: `%|${cityKey}|%` } },
				raw: true
			})) as any[];
		}

		if (!candidates.length) {
			await this.dataCoverageService.recordAttempt({
				platform: 'meta',
				jobType: 'geo_snapshot',
				metricKey: 'meta.geo.city_coordinates',
				scope: geoKey,
				success: false,
				status: 'unavailable_unsupported',
				reason: `No match in CityList (GeoNames cities15000) for "${geoKey}"; only cities with population >= 15,000 are included.`
			});
			return null;
		}

		const regionMatches = regionKey
			? candidates.filter((row) => {
				const adminKey = this.toGazetteerNameKey(row.admin1Name);
				return adminKey && (regionKey.includes(adminKey) || adminKey.includes(regionKey));
			})
			: [];
		const pool = regionMatches.length ? regionMatches : candidates;
		const best = pool.reduce((winner, row) =>
			Number(row.population || 0) > Number(winner.population || 0) ? row : winner
		);

		await this.dataCoverageService.recordAttempt({
			platform: 'meta',
			jobType: 'geo_snapshot',
			metricKey: 'meta.geo.city_coordinates',
			scope: geoKey,
			success: true
		});

		return {
			latitude: String(best.latitude),
			longitude: String(best.longitude),
			countryCode: String(best.countryCode)
		};
	}

	/** Must stay identical to `toNameKey` in tools/migration/import-geonames-cities.js —
	 * both sides of the lookup have to normalise the same way. */
	private toGazetteerNameKey(value: unknown) {
		return String(value || '')
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim();
	}

	private async fetchPaginatedEdge<T>(
		path: string,
		accessToken: string,
		params: Record<string, unknown>,
		endpointLabel: string,
		maxPages = 50,
		maxItems?: number
	) {
		const rows: T[] = [];
		let after: string | null = null;

		for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
			const response = await this.metaApiService.get<{
				data?: T[];
				paging?: { cursors?: { after?: string } };
			}>(path, {
				accessToken,
				params: {
					...params,
					...(after ? { after } : {})
				},
				endpointLabel: pageIndex === 0 ? endpointLabel : `${endpointLabel}_page_${pageIndex + 1}`
			});

				const batch = response.data || [];
				rows.push(...batch);
				if (maxItems && rows.length >= maxItems) {
					return rows.slice(0, maxItems);
				}

			const nextAfter = response.paging?.cursors?.after || null;
			if (!batch.length || !nextAfter || nextAfter === after) {
				break;
			}
			after = nextAfter;
		}

		return rows;
	}

	private async ensureMetaProfileCountColumns() {
		const sequelizeInstance = this.metaFacebookPagesRepo.sequelize;
		if (!sequelizeInstance) {
			return;
		}

		const queryInterface = sequelizeInstance.getQueryInterface();
		const facebookPageTable = await queryInterface.describeTable('MetaFacebookPages');
		if (!facebookPageTable.postCount) {
			await queryInterface.addColumn('MetaFacebookPages', 'postCount', {
				type: DataTypes.BIGINT,
				allowNull: true
			});
		}

		const instagramProfileTable = await queryInterface.describeTable('MetaInstagramProfiles');
		if (!instagramProfileTable.postCount) {
			await queryInterface.addColumn('MetaInstagramProfiles', 'postCount', {
				type: DataTypes.BIGINT,
				allowNull: true
			});
		}
	}

	private async ensureMetaInstagramMediaColumns() {
		const sequelizeInstance = this.metaInstagramMediaRepo.sequelize;
		if (!sequelizeInstance) {
			return;
		}

		const queryInterface = sequelizeInstance.getQueryInterface();
		const table = await queryInterface.describeTable('MetaInstagramMedia');
		for (const column of ['shares', 'reelsAvgWatchTimeMs', 'reelsTotalWatchTimeMs']) {
			if (!table[column]) {
				await queryInterface.addColumn('MetaInstagramMedia', column, {
					type: DataTypes.BIGINT,
					allowNull: true
				});
			}
		}
	}

	private async ensureMetaFacebookPostColumns() {
		const sequelizeInstance = this.metaFacebookPostsRepo.sequelize;
		if (!sequelizeInstance) {
			return;
		}

		const queryInterface = sequelizeInstance.getQueryInterface();
		const facebookPostTable = await queryInterface.describeTable('MetaFacebookPosts');

		if (!facebookPostTable.interactions) {
			await queryInterface.addColumn('MetaFacebookPosts', 'interactions', {
				type: DataTypes.BIGINT,
				allowNull: true
			});
		}

		if (!facebookPostTable.engagementSource) {
			await queryInterface.addColumn('MetaFacebookPosts', 'engagementSource', {
				type: DataTypes.STRING,
				allowNull: true
			});
		}

		if (!facebookPostTable.videoAvgTimeWatchedMs) {
			await queryInterface.addColumn('MetaFacebookPosts', 'videoAvgTimeWatchedMs', {
				type: DataTypes.BIGINT,
				allowNull: true
			});
		}

		if (!facebookPostTable.videoCompleteViews30s) {
			await queryInterface.addColumn('MetaFacebookPosts', 'videoCompleteViews30s', {
				type: DataTypes.BIGINT,
				allowNull: true
			});
		}

		if (!facebookPostTable.reactionsByType) {
			await queryInterface.addColumn('MetaFacebookPosts', 'reactionsByType', {
				type: DataTypes.TEXT,
				allowNull: true
			});
		}

		if (!facebookPostTable.videoRetentionGraph) {
			await queryInterface.addColumn('MetaFacebookPosts', 'videoRetentionGraph', {
				type: DataTypes.TEXT,
				allowNull: true
			});
		}

		if (!facebookPostTable.blueReelsPlayCount) {
			await queryInterface.addColumn('MetaFacebookPosts', 'blueReelsPlayCount', {
				type: DataTypes.BIGINT,
				allowNull: true
			});
		}

		if (!facebookPostTable.fbReelsTotalPlays) {
			await queryInterface.addColumn('MetaFacebookPosts', 'fbReelsTotalPlays', {
				type: DataTypes.BIGINT,
				allowNull: true
			});
		}

		if (!facebookPostTable.reelPostViews) {
			await queryInterface.addColumn('MetaFacebookPosts', 'reelPostViews', {
				type: DataTypes.BIGINT,
				allowNull: true
			});
		}

		if (!facebookPostTable.reelLengthSeconds) {
			await queryInterface.addColumn('MetaFacebookPosts', 'reelLengthSeconds', {
				type: DataTypes.FLOAT,
				allowNull: true
			});
		}
	}

	private reduceMetaInsightRows(
		rows: Array<{ name?: string; values?: Array<{ value?: number | string | Record<string, any> }> }>,
		metricMap: Record<string, string[]>
	) {
		const result: Record<string, number | null> = {};
		for (const key of Object.keys(metricMap)) {
			result[key] = null;
		}

		for (const row of rows) {
			const metricName = String(row?.name || '');
			for (const [targetKey, aliases] of Object.entries(metricMap)) {
				if (!aliases.includes(metricName)) continue;
				const rawValue = row?.values?.[0]?.value;
				result[targetKey] = this.normalizeInsightValue(rawValue);
			}
		}

		return result;
	}

	private normalizeInsightValue(value: unknown): number | null {
		if (typeof value === 'number') {
			return Number.isFinite(value) ? value : null;
		}
		if (typeof value === 'string') {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : null;
		}
		if (value && typeof value === 'object') {
			const values = Object.values(value as Record<string, unknown>)
				.map((entry) => Number(entry || 0))
				.filter((entry) => Number.isFinite(entry));
			return values.length ? values.reduce((sum, entry) => sum + entry, 0) : null;
		}
		return null;
	}

	private normalizeGeoName(geoKey: string, geoType: string) {
		if (geoType === 'country') {
			return this.resolveCountryName(geoKey);
		}

		return String(geoKey || '')
			.replace(/_/g, ' ')
			.replace(/\b\w/g, (char) => char.toUpperCase());
	}

	private resolveCountryName(geoKey: string) {
		const normalizedCode = String(geoKey || '').trim().toUpperCase();
		if (!normalizedCode) {
			return '';
		}

		return getCountryName(normalizedCode) || normalizedCode;
	}

	private async resolveInstagramAccountId(
		pageId: string,
		tokenInstagramId?: string | null,
		requestInstagramId?: string
	) {
		if (requestInstagramId) {
			return requestInstagramId;
		}
		if (tokenInstagramId) {
			return tokenInstagramId;
		}
		if (process.env.META_INSTAGRAM_ACCOUNT_ID) {
			return process.env.META_INSTAGRAM_ACCOUNT_ID;
		}

		const profile = await this.metaInstagramProfilesRepo.findOne({
			where: { pageId }
		});
		return profile?.instagramId || null;
	}

	private resolveContentDateRange(from?: string, to?: string, defaultDays = 30) {
		if (from && to) {
			return {
				startDate: from,
				endDate: to
			};
		}

		const end = new Date();
		const start = new Date();
		start.setDate(end.getDate() - defaultDays);
		return {
			startDate: this.formatDate(end < start ? end : start),
			endDate: this.formatDate(end)
		};
	}

	private resolveExplicitDateRange(
		startDate?: string,
		endDate?: string,
		maxDays = 90,
		label = 'Meta historical backfill'
	) {
		if (!startDate || !endDate) {
			throw new BadRequestException(`${label} requires both startDate and endDate`);
		}

		const start = this.parseDateOnlyString(startDate, 'startDate');
		const end = this.parseDateOnlyString(endDate, 'endDate');
		if (start.getTime() > end.getTime()) {
			throw new BadRequestException('startDate must be less than or equal to endDate');
		}

		const totalDays =
			Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
		if (totalDays > maxDays) {
			throw new BadRequestException(
				`${label} is limited to ${maxDays} days per run (requested ${totalDays})`
			);
		}

		return { startDate, endDate, totalDays };
	}

	private parseDateOnlyString(value: string, fieldName: string) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
			throw new BadRequestException(`${fieldName} must be in YYYY-MM-DD format`);
		}

		const parsed = new Date(`${value}T00:00:00.000Z`);
		if (Number.isNaN(parsed.getTime()) || this.formatDate(parsed) !== value) {
			throw new BadRequestException(`${fieldName} must be a valid calendar date`);
		}

		return parsed;
	}

	private resolveInstagramAccountInsightDays(options?: {
		windowDays?: number;
		startDate?: string;
		endDate?: string;
	}) {
		if (options?.startDate || options?.endDate) {
			const range = this.resolveExplicitDateRange(
				options?.startDate,
				options?.endDate,
				90,
				'Instagram account insights backfill'
			);
			const days: string[] = [];
			const cursor = new Date(`${range.startDate}T00:00:00.000Z`);
			const end = new Date(`${range.endDate}T00:00:00.000Z`);
			while (cursor.getTime() <= end.getTime()) {
				days.push(this.formatDate(cursor));
				cursor.setUTCDate(cursor.getUTCDate() + 1);
			}
			return days;
		}

		const windowDays = Math.max(1, Math.min(Number(options?.windowDays ?? 3), 30));
		const days: string[] = [];
		for (let offset = windowDays; offset >= 1; offset -= 1) {
			const d = new Date();
			d.setUTCDate(d.getUTCDate() - offset);
			days.push(this.formatDate(d));
		}
		return days;
	}

	private formatDate(date: Date) {
		return date.toISOString().slice(0, 10);
	}

	private normalizeContentLimit(value?: number | null) {
		if (!Number.isFinite(Number(value))) {
			return null;
		}

		const normalized = Math.floor(Number(value));
		return normalized > 0 ? normalized : null;
	}

	private toStringOrNull(value: unknown) {
		if (value === null || value === undefined) return null;
		if (typeof value === 'number' && !Number.isFinite(value)) return null;
		return String(value);
	}
}
