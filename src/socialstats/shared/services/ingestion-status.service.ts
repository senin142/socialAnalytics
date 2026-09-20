import {
	IngestionRuns,
	MetaAccountTokens,
	MetaFacebookPosts,
	MetaInstagramMedia,
	YoutubeLiveViewerStats,
	YoutubeVideoGeoStats
} from '../../../database/entity';
import { Inject, Injectable } from '@nestjs/common';
import { Op } from 'sequelize';
import { DataCoverageService } from './data-coverage.service';
import { IngestionControlService } from './ingestion-control.service';

type FreshnessConfig = {
	platform: string;
	jobType: string;
	entityType: string;
	expectedCadenceMinutes: number;
	staleAfterMinutes: number;
	/** A successful run of this job always writes rows, so a "completed" run with
	 * recordsUpserted = 0 is not evidence of freshness — only the last run that actually
	 * wrote something is. Left off for jobs that can legitimately have nothing to write
	 * (no live stream, no new report). */
	expectsRecords?: boolean;
};

@Injectable()
export class IngestionStatusService {
	private readonly freshnessConfigs: FreshnessConfig[] = [
		{
			platform: 'meta',
			jobType: 'profile_snapshot',
			entityType: 'page',
			expectedCadenceMinutes: 1440,
			staleAfterMinutes: 2160,
			expectsRecords: true
		},
		{
			platform: 'meta',
			jobType: 'content_snapshot',
			entityType: 'page',
			expectedCadenceMinutes: 360,
			staleAfterMinutes: 720,
			expectsRecords: true
		},
		{
			platform: 'meta',
			jobType: 'geo_snapshot',
			entityType: 'page',
			expectedCadenceMinutes: 1440,
			staleAfterMinutes: 2160,
			expectsRecords: true
		},
		{
			platform: 'youtube',
			jobType: 'channel_stats',
			entityType: 'channel',
			expectedCadenceMinutes: 60,
			staleAfterMinutes: 180,
			expectsRecords: true
		},
		{
			platform: 'youtube',
			jobType: 'live_viewers',
			entityType: 'channel',
			expectedCadenceMinutes: 2,
			staleAfterMinutes: 10
		},
		{
			platform: 'youtube',
			jobType: 'video_retention',
			entityType: 'channel',
			expectedCadenceMinutes: 1440,
			staleAfterMinutes: 2160,
			expectsRecords: true
		},
		{
			platform: 'youtube',
			jobType: 'geo_device',
			entityType: 'channel',
			expectedCadenceMinutes: 1440,
			staleAfterMinutes: 2160,
			expectsRecords: true
		},
		{
			platform: 'youtube',
			jobType: 'analytics_snapshot',
			entityType: 'channel',
			expectedCadenceMinutes: 1440,
			staleAfterMinutes: 2160,
			expectsRecords: true
		},
		{
			platform: 'youtube',
			jobType: 'reach_reports',
			entityType: 'channel',
			expectedCadenceMinutes: 1440,
			staleAfterMinutes: 2160
		},
		{
			platform: 'linkedin',
			jobType: 'organization_overview',
			entityType: 'organization',
			expectedCadenceMinutes: 1440,
			staleAfterMinutes: 2160,
			expectsRecords: true
		},
		{
			platform: 'linkedin',
			jobType: 'follower_statistics',
			entityType: 'organization',
			expectedCadenceMinutes: 1440,
			staleAfterMinutes: 2160,
			expectsRecords: true
		},
		{
			platform: 'linkedin',
			jobType: 'page_statistics',
			entityType: 'organization',
			expectedCadenceMinutes: 1440,
			staleAfterMinutes: 2160,
			expectsRecords: true
		},
		{
			platform: 'linkedin',
			jobType: 'share_statistics',
			entityType: 'organization',
			expectedCadenceMinutes: 1440,
			staleAfterMinutes: 2160,
			expectsRecords: true
		},
		{
			platform: 'tiktok',
			jobType: 'account_overview',
			entityType: 'account',
			expectedCadenceMinutes: 1440,
			staleAfterMinutes: 2160,
			expectsRecords: true
		},
		{
			platform: 'tiktok',
			jobType: 'video_stats',
			entityType: 'account',
			expectedCadenceMinutes: 1440,
			staleAfterMinutes: 2160,
			expectsRecords: true
		}
	];

	constructor(
		@Inject('INGESTION_RUNS_REPOSITORY')
		private readonly ingestionRunsRepo: typeof IngestionRuns,
		@Inject('META_FACEBOOK_POSTS_REPOSITORY')
		private readonly metaFacebookPostsRepo: typeof MetaFacebookPosts,
		@Inject('META_INSTAGRAM_MEDIA_REPOSITORY')
		private readonly metaInstagramMediaRepo: typeof MetaInstagramMedia,
		@Inject('YOUTUBE_LIVE_VIEWER_STATS_REPOSITORY')
		private readonly youtubeLiveViewerStatsRepo: typeof YoutubeLiveViewerStats,
		@Inject('YOUTUBE_VIDEO_GEO_STATS_REPOSITORY')
		private readonly youtubeVideoGeoStatsRepo: typeof YoutubeVideoGeoStats,
		@Inject('META_ACCOUNT_TOKENS_REPOSITORY')
		private readonly metaAccountTokensRepo: typeof MetaAccountTokens,
		private readonly dataCoverageService: DataCoverageService,
		private readonly ingestionControlService: IngestionControlService
	) { }

	async getStatus(platform?: string) {
		const freshness = await this.buildFreshness(platform);
		const running = await this.ingestionRunsRepo.findAll({
			where: {
				...(platform ? { platform } : {}),
				status: 'running',
				[Op.or]: [
					{ leaseExpiresAt: null },
					{
						leaseExpiresAt: {
							[Op.gt]: new Date()
						}
					}
				]
			},
			order: [['startedAt', 'DESC']],
			raw: true
		});
		const latestRuns = await this.buildLatestRuns(platform);
		const failures = await this.buildRecentFailures(platform);
		const platformSummary = this.buildPlatformSummary(freshness, failures);
		const credentials = await this.buildCredentialStatus(platform);
		const contentBoundaries = await this.buildContentBoundaries(platform);
		// Freshness only tells us whether jobs are current; controls/coverage add the
		// operational context for intentional pauses and API/reporting gaps.
		const dataCoverage = await this.dataCoverageService.getCoverage(platform);
		const controls = await this.ingestionControlService.getAllControls(platform);
		for (const control of controls) {
			if (control.scope === 'platform' && control.paused && platformSummary[control.platform]) {
				platformSummary[control.platform].status = 'paused';
			}
		}
		const platforms = Object.fromEntries(
			Object.entries(platformSummary).map(([platformKey, summary]) => {
				const platformControls = controls.filter((control) => control.platform === platformKey);
				const platformPause = platformControls.find(
					(control) => control.scope === 'platform' && control.paused
				);
				const pausedJobs = platformControls.filter(
					(control) => control.scope === 'job' && control.paused
				);
				return [
					platformKey,
					{
						...summary,
						contentWindow: contentBoundaries[platformKey] ?? null,
						paused: Boolean(platformPause),
						pauseReason: platformPause?.reason ?? null,
						pausedJobTypes: pausedJobs.map((control) => control.jobType)
					}
				];
			})
		);

		return {
			statusCode: 200,
			message: 'Social ingestion status fetched successfully',
			generatedAt: new Date().toISOString(),
			data: {
				overall: this.buildOverallStatus(platformSummary),
				platforms,
				freshness,
				running: running.map((run: any) => ({
					runId: run.id,
					platform: run.platform,
					jobType: run.jobType,
					runType: run.runType,
					entityType: run.entityType,
					entityId: run.entityId,
					startedAt: run.startedAt,
					leaseExpiresAt: run.leaseExpiresAt,
					heartbeatAt: run.heartbeatAt,
					recordsFetched: Number(run.recordsFetched || 0),
					recordsProcessed: Number(run.recordsProcessed || 0),
					recordsUpserted: Number(run.recordsUpserted || 0),
					status: run.status
				})),
				latestRuns,
				failures: {
					recent: failures.map((run: any) => ({
						runId: run.id,
						platform: run.platform,
						jobType: run.jobType,
						entityType: run.entityType,
						entityId: run.entityId,
						status: run.status,
						errorCode: run.errorCode,
						errorMessage: run.errorMessage,
						finishedAt: run.finishedAt
					}))
				},
				dataCoverage,
				controls,
				credentials
			}
		};
	}

	private trackedPlatforms(platform?: string) {
		return Array.from(
			new Set(
				this.freshnessConfigs
					.filter((config) => !platform || config.platform === platform)
					.map((config) => config.platform)
			)
		);
	}

	/**
	 * Per platform, not a single global top-N: one noisy job (YouTube's every-2-minutes
	 * live_viewers failing on a bad token) filled the whole global list and made every
	 * other platform's failures invisible to the summary.
	 */
	private async buildRecentFailures(platform?: string, perPlatformLimit = 10) {
		const perPlatform = await Promise.all(
			this.trackedPlatforms(platform).map((targetPlatform) =>
				this.ingestionRunsRepo.findAll({
					where: {
						platform: targetPlatform,
						status: {
							[Op.in]: ['failed', 'partial']
						}
					},
					order: [['finishedAt', 'DESC']],
					limit: perPlatformLimit,
					raw: true
				})
			)
		);

		return perPlatform
			.flat()
			.sort(
				(a: any, b: any) =>
					new Date(b.finishedAt || 0).getTime() - new Date(a.finishedAt || 0).getTime()
			);
	}

	/**
	 * Surfaces stored OAuth credentials that are about to lapse. Only Meta keeps its tokens
	 * in the DB (YouTube's refresh token is env-only, LinkedIn/TikTok are not connected
	 * yet), so this is Meta-only for now; the shape leaves room for the others.
	 */
	private async buildCredentialStatus(platform?: string) {
		if (platform && platform !== 'meta') {
			return {};
		}

		const warnWithinDays = 14;
		const rows = await this.metaAccountTokensRepo.findAll({
			attributes: ['accountType', 'expiresAt', 'isExpired', 'refreshStatus', 'lastRefreshedAt'],
			raw: true
		});
		const now = Date.now();
		const tokens = (rows as any[]).map((row) => {
			const expiresAt = row.expiresAt ? new Date(row.expiresAt) : null;
			const daysRemaining = expiresAt
				? Math.floor((expiresAt.getTime() - now) / 86_400_000)
				: null;
			return {
				accountType: row.accountType,
				expiresAt: expiresAt ? expiresAt.toISOString() : null,
				daysRemaining,
				lastRefreshedAt: row.lastRefreshedAt ?? null,
				refreshStatus: row.refreshStatus ?? null,
				status:
					row.isExpired || (daysRemaining !== null && daysRemaining < 0)
						? 'expired'
						: daysRemaining !== null && daysRemaining <= warnWithinDays
							? 'expiring_soon'
							: 'ok'
			};
		});

		return {
			meta: {
				status: tokens.some((token) => token.status === 'expired')
					? 'expired'
					: tokens.some((token) => token.status === 'expiring_soon')
						? 'expiring_soon'
						: tokens.length
							? 'ok'
							: 'not_connected',
				tokens
			}
		};
	}

	async getRuns(options?: {
		platform?: string;
		status?: string;
		limit?: number;
	}) {
		const limit = Math.min(Math.max(Number(options?.limit || 50), 1), 200);
		const runs = await this.ingestionRunsRepo.findAll({
			where: {
				...(options?.platform ? { platform: options.platform } : {}),
				...(options?.status ? { status: options.status } : {})
			},
			order: [['createdAt', 'DESC']],
			limit,
			raw: true
		});

		return {
			statusCode: 200,
			message: 'Social ingestion runs fetched successfully',
			data: runs
		};
	}

	private async buildFreshness(platform?: string) {
		const configs = this.freshnessConfigs.filter(
			(config) => !platform || config.platform === platform
		);
		const rows = await Promise.all(
			configs.map(async (config) => {
				const completedWhere = {
					platform: config.platform,
					jobType: config.jobType,
					entityType: config.entityType,
					status: 'completed'
				};
				const latestCompleted = await this.ingestionRunsRepo.findOne({
					where: completedWhere,
					order: [['finishedAt', 'DESC']],
					raw: true
				});
				// For jobs that always write on success, "fresh" has to mean the last run
				// that wrote rows — geo_device "completed" nightly for two months with zero
				// upserts while its table sat frozen, and the old check called that fresh.
				const latestSuccess =
					config.expectsRecords && Number(latestCompleted?.recordsUpserted || 0) === 0
						? await this.ingestionRunsRepo.findOne({
							where: { ...completedWhere, recordsUpserted: { [Op.gt]: 0 } },
							order: [['finishedAt', 'DESC']],
							raw: true
						})
						: latestCompleted;
				const lastSuccessfulRunAt = latestSuccess?.finishedAt || latestSuccess?.startedAt || null;
				const lastCompletedRunAt = latestCompleted?.finishedAt || latestCompleted?.startedAt || null;
				const minutesSinceSuccess = lastSuccessfulRunAt
					? Math.max(
						0,
						Math.floor(
							(new Date().getTime() - new Date(lastSuccessfulRunAt).getTime()) / 60_000
						)
					)
					: null;

				return {
					platform: config.platform,
					jobType: config.jobType,
					entityType: config.entityType,
					entityId: latestSuccess?.entityId ?? 'default',
					expectedCadenceMinutes: config.expectedCadenceMinutes,
					staleAfterMinutes: config.staleAfterMinutes,
					expectsRecords: Boolean(config.expectsRecords),
					lastSuccessfulRunAt,
					// Differs from lastSuccessfulRunAt only when recent runs completed without
					// writing anything — the "job runs but data is not moving" signature.
					lastCompletedRunAt,
					minutesSinceSuccess,
					status:
						lastSuccessfulRunAt && minutesSinceSuccess !== null
							? minutesSinceSuccess > config.staleAfterMinutes
								? 'stale'
								: 'fresh'
							: 'missing'
				};
			})
		);

		return rows;
	}

	private async buildLatestRuns(platform?: string) {
		const targetPlatforms = this.trackedPlatforms(platform);
		const entries = await Promise.all(
			targetPlatforms.map(async (targetPlatform) => {
				const [latestSuccess, latestFailure] = await Promise.all([
					this.ingestionRunsRepo.findOne({
						where: {
							platform: targetPlatform,
							status: 'completed'
						},
						order: [['finishedAt', 'DESC']],
						raw: true
					}),
					this.ingestionRunsRepo.findOne({
						where: {
							platform: targetPlatform,
							status: {
								[Op.in]: ['failed', 'partial']
							}
						},
						order: [['finishedAt', 'DESC']],
						raw: true
					})
				]);

				return [
					targetPlatform,
					{
						latestSuccess,
						latestFailure
					}
				] as const;
			})
		);

		return Object.fromEntries(entries);
	}

	private async buildContentBoundaries(platform?: string) {
		const targetPlatforms = platform ? [platform] : ['meta', 'youtube'];
		const entries = await Promise.all(
			targetPlatforms.map(async (targetPlatform) => {
				if (targetPlatform === 'meta') {
					return [targetPlatform, await this.buildMetaContentWindow()] as const;
				}

				if (targetPlatform === 'youtube') {
					return [targetPlatform, await this.buildYoutubeContentWindow()] as const;
				}

				return [targetPlatform, null] as const;
			})
		);

		return Object.fromEntries(entries);
	}

	private async buildMetaContentWindow() {
		const [
			oldestFacebookPost,
			latestFacebookPost,
			oldestInstagramMedia,
			latestInstagramMedia
		] = await Promise.all([
			this.metaFacebookPostsRepo.findOne({
				where: {
					createdTime: {
						[Op.ne]: null
					}
				},
				order: [['createdTime', 'ASC']],
				raw: true
			}),
			this.metaFacebookPostsRepo.findOne({
				where: {
					createdTime: {
						[Op.ne]: null
					}
				},
				order: [['createdTime', 'DESC']],
				raw: true
			}),
			this.metaInstagramMediaRepo.findOne({
				where: {
					timestamp: {
						[Op.ne]: null
					}
				},
				order: [['timestamp', 'ASC']],
				raw: true
			}),
			this.metaInstagramMediaRepo.findOne({
				where: {
					timestamp: {
						[Op.ne]: null
					}
				},
				order: [['timestamp', 'DESC']],
				raw: true
			})
		]);

		const candidates = {
			oldest: [
				this.normalizeMetaFacebookContentBoundary(oldestFacebookPost),
				this.normalizeMetaInstagramContentBoundary(oldestInstagramMedia)
			].filter(Boolean) as any[],
			latest: [
				this.normalizeMetaFacebookContentBoundary(latestFacebookPost),
				this.normalizeMetaInstagramContentBoundary(latestInstagramMedia)
			].filter(Boolean) as any[]
		};

		return {
			oldestContent: candidates.oldest.length
				? candidates.oldest.sort(
					(a, b) =>
						new Date(a.uploadDate).getTime() - new Date(b.uploadDate).getTime()
				)[0]
				: null,
			latestContent: candidates.latest.length
				? candidates.latest.sort(
					(a, b) =>
						new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime()
				)[0]
				: null
		};
	}

	private async buildYoutubeContentWindow() {
		const [oldestLiveContent, latestLiveContent] = await Promise.all([
			this.youtubeLiveViewerStatsRepo.findOne({
				where: {
					actualStartTime: {
						[Op.ne]: null
					}
				},
				order: [['actualStartTime', 'ASC']],
				raw: true
			}),
			this.youtubeLiveViewerStatsRepo.findOne({
				where: {
					actualStartTime: {
						[Op.ne]: null
					}
				},
				order: [['actualStartTime', 'DESC']],
				raw: true
			})
		]);

		if (oldestLiveContent || latestLiveContent) {
			return {
				oldestContent: this.normalizeYoutubeLiveContentBoundary(oldestLiveContent),
				latestContent: this.normalizeYoutubeLiveContentBoundary(latestLiveContent)
			};
		}

		const [oldestTrackedVideo, latestTrackedVideo] = await Promise.all([
			this.youtubeVideoGeoStatsRepo.findOne({
				order: [['date', 'ASC']],
				raw: true
			}),
			this.youtubeVideoGeoStatsRepo.findOne({
				order: [['date', 'DESC']],
				raw: true
			})
		]);

		return {
			oldestContent: this.normalizeYoutubeTrackedContentBoundary(oldestTrackedVideo),
			latestContent: this.normalizeYoutubeTrackedContentBoundary(latestTrackedVideo)
		};
	}

	private normalizeMetaFacebookContentBoundary(row: any) {
		if (!row?.postId || !row?.createdTime) {
			return null;
		}

		return {
			contentId: row.postId,
			sourceType: 'facebook_post',
			uploadDate: row.createdTime,
			dbUpdatedAt: row.updatedAt ?? null
		};
	}

	private normalizeMetaInstagramContentBoundary(row: any) {
		if (!row?.mediaId || !row?.timestamp) {
			return null;
		}

		return {
			contentId: row.mediaId,
			sourceType: 'instagram_media',
			uploadDate: row.timestamp,
			dbUpdatedAt: row.updatedAt ?? null
		};
	}

	private normalizeYoutubeLiveContentBoundary(row: any) {
		if (!row?.videoId || !row?.actualStartTime) {
			return null;
		}

		return {
			contentId: row.videoId,
			sourceType: 'youtube_live_video',
			uploadDate: row.actualStartTime,
			dbUpdatedAt: row.updatedAt ?? null
		};
	}

	private normalizeYoutubeTrackedContentBoundary(row: any) {
		if (!row?.videoId || !row?.date) {
			return null;
		}

		return {
			contentId: row.videoId,
			sourceType: 'youtube_tracked_video',
			uploadDate: null,
			dbUpdatedAt: row.updatedAt ?? null,
			firstTrackedDate: row.date
		};
	}

	private buildPlatformSummary(freshness: any[], failures: any[]) {
		const grouped = new Map<string, any[]>();
		for (const row of freshness) {
			const existing = grouped.get(row.platform) || [];
			existing.push(row);
			grouped.set(row.platform, existing);
		}

		const summary: Record<string, { status: string; summary: string }> = {};
		for (const [platform, rows] of grouped.entries()) {
			const statuses = rows.map((row) => row.status);
			// A failure only counts against the platform while it is the latest word on its
			// job. Once a later run of the same job has succeeded it is history, not a live
			// problem — otherwise yesterday's rate-limit blip keeps a platform "degraded"
			// even though every job it tracks is fresh.
			const recentFailure = failures.find((failure: any) => {
				if (failure.platform !== platform) {
					return false;
				}
				const jobRow = rows.find((row) => row.jobType === failure.jobType);
				if (!jobRow?.lastSuccessfulRunAt || !failure.finishedAt) {
					return true;
				}
				return (
					new Date(failure.finishedAt).getTime() >
					new Date(jobRow.lastSuccessfulRunAt).getTime()
				);
			});
			const status = statuses.includes('stale')
				? 'stale'
				: statuses.includes('missing')
					? 'degraded'
					: recentFailure
						? 'degraded'
						: 'fresh';
			summary[platform] = {
				status,
				summary: rows
					.map((row) => `${row.jobType}:${row.status}`)
					.join(', ')
			};
		}

		return summary;
	}

	private buildOverallStatus(platformSummary: Record<string, { status: string; summary: string }>) {
		const statuses = Object.values(platformSummary).map((entry) => entry.status);
		// "paused" is deliberate (an admin asked for it), not a problem, but it still needs
		// to be visibly distinct from "stale"/"degraded" so a paused platform doesn't read
		// as broken.
		const status = statuses.includes('stale')
			? 'stale'
			: statuses.includes('degraded')
				? 'degraded'
				: statuses.includes('paused')
					? 'paused'
					: statuses.length
						? 'fresh'
						: 'missing';
		return {
			status,
			summary: Object.entries(platformSummary)
				.map(([platform, entry]) => `${platform}: ${entry.status}`)
				.join(', ')
		};
	}
}
