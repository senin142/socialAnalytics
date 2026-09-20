import { TiktokAccountStats, TiktokVideoStats } from '../../../database/entity';
import { logToErrorFile } from '../../../common/logger';
import { BadGatewayException, HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Op } from 'sequelize';
import { DataCoverageService } from '../../shared/services/data-coverage.service';
import { TiktokApiService } from './tiktok-api.service';
import { TiktokAuthService } from './tiktok-auth.service';
import { TiktokQuotaService } from './tiktok-quota.service';

const USER_INFO_FIELDS = [
	'open_id',
	'union_id',
	'avatar_url',
	'display_name',
	'username',
	'profile_deep_link',
	'is_verified',
	'follower_count',
	'following_count',
	'likes_count',
	'video_count'
];

const VIDEO_LIST_FIELDS = [
	'id',
	'create_time',
	'title',
	'video_description',
	'duration',
	'cover_image_url',
	'share_url',
	'embed_link',
	'view_count',
	'like_count',
	'comment_count',
	'share_count'
];

// TikTok caps /v2/video/list/ at 20 items per page. The page cap keeps one ingest run bounded
// against the per-minute rate limit rather than walking an unbounded back catalogue.
const VIDEO_PAGE_SIZE = 20;
const MAX_VIDEO_PAGES = Number(process.env.TIKTOK_MAX_VIDEO_PAGES ?? 5);

/**
 * Read-facing service for TikTok account analytics — same shape as LinkedinService and
 * YoutubeService: serve a short-lived cache, persist a durable snapshot on every fetch, and
 * record a DataCoverageService attempt either way so /socialstats/ingestion/status can report
 * on TikTok alongside the other platforms.
 *
 * Two behaviours are specific to TikTok's rules rather than copied from the other platforms:
 *
 * - A MISSING SCOPE IS NOT A FAILURE. If the account granted user.info.basic but not
 *   user.info.stats, TikTok returns a perfectly valid response with the counts absent (or a
 *   scope_not_authorized error). That's recorded as `unavailable_permission` — an actionable
 *   "re-authorize with more scopes" gap — instead of being logged as an outage.
 * - CACHED CONTENT HAS TO BE KEPT CURRENT OR DROPPED. TikTok's Developer Terms require that
 *   stored TikTok data be refreshed, and that content removed by the creator (or data covered
 *   by a withdrawn authorization) stop being retained. purgeStaleContent/purgeAllContent below
 *   are what discharge that, driven by the crons in TiktokIngestService.
 */
@Injectable()
export class TiktokService implements OnModuleInit {
	private readonly logger = new Logger(TiktokService.name);
	private readonly responseCache = new Map<string, { expiresAt: number; value: any }>();
	private readonly retentionDays = Number(process.env.TIKTOK_DATA_RETENTION_DAYS ?? 90);

	constructor(
		private readonly tiktokApiService: TiktokApiService,
		private readonly tiktokAuthService: TiktokAuthService,
		private readonly tiktokQuotaService: TiktokQuotaService,
		private readonly dataCoverageService: DataCoverageService,
		@Inject('TIKTOK_ACCOUNT_STATS_REPOSITORY')
		private readonly tiktokAccountStatsRepo: typeof TiktokAccountStats,
		@Inject('TIKTOK_VIDEO_STATS_REPOSITORY')
		private readonly tiktokVideoStatsRepo: typeof TiktokVideoStats
	) { }

	async onModuleInit() {
		await this.tiktokAccountStatsRepo.sync();
		await this.tiktokVideoStatsRepo.sync();
	}

	async getAccountOverview() {
		const cacheKey = 'tiktok:account-overview';
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const metricKey = 'tiktok.account.overview';
		try {
			const user = await this.tiktokApiService.get<{ user?: Record<string, any> }>('/user/info/', {
				fields: USER_INFO_FIELDS,
				endpointLabel: 'tiktok.user.info'
			});

			const profile = user?.user ?? {};
			const openId = profile.open_id ?? (await this.tiktokAuthService.getAccessToken()).openId;
			const followerCount = this.toNumberOrNull(profile.follower_count);

			const snapshot = await this.tiktokAccountStatsRepo.create({
				openId,
				username: profile.username ?? null,
				displayName: profile.display_name ?? null,
				isVerified: typeof profile.is_verified === 'boolean' ? profile.is_verified : null,
				followerCount,
				followingCount: this.toNumberOrNull(profile.following_count),
				likesCount: this.toNumberOrNull(profile.likes_count),
				videoCount: this.toNumberOrNull(profile.video_count),
				profileDeepLink: profile.profile_deep_link ?? null,
				fetchedAt: new Date()
			});

			const result = {
				statusCode: HttpStatus.OK,
				message: 'TikTok account overview fetched successfully',
				data: {
					openId,
					username: snapshot.username,
					displayName: snapshot.displayName,
					isVerified: snapshot.isVerified,
					followerCount: snapshot.followerCount,
					followingCount: snapshot.followingCount,
					likesCount: snapshot.likesCount,
					videoCount: snapshot.videoCount,
					profileDeepLink: snapshot.profileDeepLink,
					fetchedAt: snapshot.fetchedAt
				}
			};
			this.setCache(cacheKey, result, 10 * 60_000);

			// The counts are the point of this endpoint; a response without them means
			// user.info.stats was never granted, which is a permission gap the admin can fix.
			await this.dataCoverageService.recordAttempt({
				platform: 'tiktok',
				jobType: 'account_overview',
				metricKey,
				success: followerCount !== null,
				status: followerCount !== null ? undefined : 'unavailable_permission',
				reason:
					followerCount !== null
						? undefined
						: 'TikTok returned no follower counts — the user.info.stats scope was most likely not granted'
			});
			return result;
		} catch (err) {
			logToErrorFile(err, 'Error while fetching TikTok account overview');
			await this.recordCoverageFailure('account_overview', metricKey, err);
			throw new BadGatewayException(`Unable to fetch TikTok account overview: ${this.describeError(err)}`);
		}
	}

	/**
	 * Walks /v2/video/list/ and snapshots per-video engagement. When the whole catalogue is
	 * traversed (TikTok stops setting has_more), videos we hold but TikTok no longer lists are
	 * flagged deleted so the retention job can drop them — a partial walk deliberately skips
	 * that step, since absence from page 1 of N proves nothing about deletion.
	 */
	async getVideoStats(maxPages = MAX_VIDEO_PAGES) {
		const cacheKey = `tiktok:video-stats:${maxPages}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const metricKey = 'tiktok.videos.engagement';
		try {
			const { openId } = await this.tiktokAuthService.getAccessToken();
			const capturedAt = new Date();
			const seenVideoIds: string[] = [];
			let cursor: number | undefined;
			let pagesFetched = 0;
			let exhausted = false;

			while (pagesFetched < maxPages) {
				const page = await this.tiktokApiService.post<{
					videos?: Array<Record<string, any>>;
					cursor?: number;
					has_more?: boolean;
				}>('/video/list/', {
					fields: VIDEO_LIST_FIELDS,
					body: cursor ? { cursor, max_count: VIDEO_PAGE_SIZE } : { max_count: VIDEO_PAGE_SIZE },
					endpointLabel: 'tiktok.video.list'
				});

				const videos = page?.videos ?? [];
				for (const video of videos) {
					if (!video?.id) continue;
					seenVideoIds.push(String(video.id));
					await this.tiktokVideoStatsRepo.create({
						openId,
						videoId: String(video.id),
						title: video.title ?? null,
						videoDescription: video.video_description ?? null,
						// create_time is unix seconds, not milliseconds.
						postedAt: video.create_time ? new Date(Number(video.create_time) * 1000) : null,
						durationSeconds: this.toNumberOrNull(video.duration),
						coverImageUrl: video.cover_image_url ?? null,
						shareUrl: video.share_url ?? null,
						embedLink: video.embed_link ?? null,
						viewCount: this.toNumberOrNull(video.view_count) ?? 0,
						likeCount: this.toNumberOrNull(video.like_count) ?? 0,
						commentCount: this.toNumberOrNull(video.comment_count) ?? 0,
						shareCount: this.toNumberOrNull(video.share_count) ?? 0,
						capturedAt,
						deletedAt: null
					});
				}

				pagesFetched++;
				cursor = page?.cursor;
				if (!page?.has_more || !cursor) {
					exhausted = true;
					break;
				}
			}

			if (exhausted) {
				await this.flagRemovedVideos(openId, seenVideoIds);
			}

			const result = {
				statusCode: HttpStatus.OK,
				message: 'TikTok video statistics fetched successfully',
				data: {
					openId,
					videosCaptured: seenVideoIds.length,
					pagesFetched,
					fullCatalogueTraversed: exhausted,
					capturedAt
				}
			};
			this.setCache(cacheKey, result, 10 * 60_000);
			await this.dataCoverageService.recordAttempt({
				platform: 'tiktok',
				jobType: 'video_stats',
				metricKey,
				success: seenVideoIds.length > 0,
				status: seenVideoIds.length > 0 ? undefined : 'unavailable_insufficient_data',
				reason: seenVideoIds.length > 0 ? undefined : 'TikTok returned no videos for this account'
			});
			return result;
		} catch (err) {
			logToErrorFile(err, 'Error while fetching TikTok video statistics');
			await this.recordCoverageFailure('video_stats', metricKey, err);
			throw new BadGatewayException(`Unable to fetch TikTok video statistics: ${this.describeError(err)}`);
		}
	}

	/**
	 * Discharges the retention half of TikTok's Developer Terms: content the creator has
	 * removed is dropped outright, and ordinary snapshots age out of the retention window.
	 *
	 * TIKTOK_DATA_RETENTION_DAYS is a deliberately conservative house default rather than a
	 * number TikTok publishes — confirm the window with whoever owns the platform agreement
	 * before widening it.
	 */
	async purgeStaleContent() {
		const removed = await this.tiktokVideoStatsRepo.destroy({
			where: { deletedAt: { [Op.ne]: null } }
		});

		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - this.retentionDays);
		const aged = await this.tiktokVideoStatsRepo.destroy({
			where: { capturedAt: { [Op.lt]: cutoff } }
		});
		const agedProfiles = await this.tiktokAccountStatsRepo.destroy({
			where: { fetchedAt: { [Op.lt]: cutoff } }
		});

		this.logger.log(
			`TikTok retention sweep: ${removed} deleted-video rows, ${aged} aged video rows, ${agedProfiles} aged profile rows`
		);
		return { removedVideoRows: removed, agedVideoRows: aged, agedProfileRows: agedProfiles, retentionDays: this.retentionDays };
	}

	/** Full erasure of derived TikTok data — used when the account holder withdraws consent. */
	async purgeAllContent() {
		const videoRows = await this.tiktokVideoStatsRepo.destroy({ where: {} });
		const profileRows = await this.tiktokAccountStatsRepo.destroy({ where: {} });
		this.responseCache.clear();
		this.logger.log(`TikTok authorization withdrawn: purged ${videoRows} video rows and ${profileRows} profile rows`);
		return { videoRows, profileRows };
	}

	private async flagRemovedVideos(openId: string, seenVideoIds: string[]) {
		// An empty list is the "creator deleted everything" case, and it is the one that matters
		// most for retention: every row we hold is now orphaned. It needs its own branch because
		// `notIn: []` matches no rows in Sequelize, which would silently leave them all active.
		const where = seenVideoIds.length
			? { openId, videoId: { [Op.notIn]: seenVideoIds }, deletedAt: null }
			: { openId, deletedAt: null };

		await this.tiktokVideoStatsRepo.update({ deletedAt: new Date() }, { where });
	}

	private toNumberOrNull(value: unknown) {
		if (value === null || value === undefined || value === '') {
			return null;
		}
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	private describeError(err: any) {
		// TiktokAuthService throws plain Errors for "not authorized yet" / "re-authorize" —
		// those messages already say what to do, so they are surfaced verbatim.
		if (err instanceof Error && !err['response'] && !err['tiktokErrorCode']) {
			return err.message;
		}
		return this.tiktokApiService.getErrorMessage(err);
	}

	private async recordCoverageFailure(jobType: string, metricKey: string, err: any) {
		await this.dataCoverageService.recordAttempt({
			platform: 'tiktok',
			jobType,
			metricKey,
			success: false,
			// A throttle and a missing scope are both recoverable and mean different things to
			// whoever reads the status dashboard — neither should look like "TikTok can't do this".
			status: this.tiktokQuotaService.isQuotaExceededError(err)
				? 'unavailable_quota'
				: this.tiktokApiService.isScopeError(err)
					? 'unavailable_permission'
					: 'unavailable_unsupported',
			reason: this.describeError(err)
		});
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
		this.responseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
	}
}
