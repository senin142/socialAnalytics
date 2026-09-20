import {
	LinkedinFollowerStats,
	LinkedinOrganizationStats,
	LinkedinPageStats,
	LinkedinShareStats
} from '../../../database/entity';
import { logToErrorFile } from '../../../common/logger';
import { BadGatewayException, HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataCoverageService } from '../../shared/services/data-coverage.service';
import { LinkedinApiService } from './linkedin-api.service';
import { LinkedinAuthService } from './linkedin-auth.service';

const FOLLOWER_FACETS = [
	'followerCountsByAssociationType',
	'followerCountsByGeoCountry',
	'followerCountsByFunction',
	'followerCountsByIndustry',
	'followerCountsByGeo',
	'followerCountsBySeniority',
	'followerCountsByStaffCountRange'
] as const;

/**
 * Read-facing service for LinkedIn organization analytics — mirrors YoutubeService/
 * MetaDashboardService: cache a live response briefly, persist a durable snapshot on every
 * fetch (dashboard-triggered or cron), and record a DataCoverageService attempt either way so
 * the shared /socialstats/ingestion/status endpoint can report on LinkedIn like it does Meta
 * and YouTube. Every method here fails closed with a clear, actionable BadGatewayException
 * when LinkedinAuthService isn't configured yet — see that service for why (no credentials =
 * expected pre-launch state, not a bug).
 */
@Injectable()
export class LinkedinService implements OnModuleInit {
	private readonly logger = new Logger(LinkedinService.name);
	private readonly responseCache = new Map<string, { expiresAt: number; value: any }>();

	constructor(
		private readonly linkedinApiService: LinkedinApiService,
		private readonly linkedinAuthService: LinkedinAuthService,
		private readonly dataCoverageService: DataCoverageService,
		@Inject('LINKEDIN_ORGANIZATION_STATS_REPOSITORY')
		private readonly linkedinOrganizationStatsRepo: typeof LinkedinOrganizationStats,
		@Inject('LINKEDIN_FOLLOWER_STATS_REPOSITORY')
		private readonly linkedinFollowerStatsRepo: typeof LinkedinFollowerStats,
		@Inject('LINKEDIN_PAGE_STATS_REPOSITORY')
		private readonly linkedinPageStatsRepo: typeof LinkedinPageStats,
		@Inject('LINKEDIN_SHARE_STATS_REPOSITORY')
		private readonly linkedinShareStatsRepo: typeof LinkedinShareStats
	) { }

	async onModuleInit() {
		await this.linkedinOrganizationStatsRepo.sync();
		await this.linkedinFollowerStatsRepo.sync();
		await this.linkedinPageStatsRepo.sync();
		await this.linkedinShareStatsRepo.sync();
	}

	async getOrganizationOverview() {
		const cacheKey = 'linkedin:organization-overview';
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const metricKey = 'linkedin.organization.overview';
		try {
			const { accessToken: _accessToken, organizationUrn } = await this.linkedinAuthService.getAccessToken();

			const [networkSize, pageStats] = await Promise.all([
				this.linkedinApiService.get<{ firstDegreeSize?: number }>(
					`/networkSizes/${encodeURIComponent(organizationUrn)}`,
					{
						// COMPANY_FOLLOWED_BY_MEMBER (not the older CompanyFollowedByMember) from
						// v202305 onward, on the versioned /rest surface. LinkedIn documents the
						// two spellings as not retrocompatible, so this has to move in step with
						// LINKEDIN_API_VERSION if that is ever pinned back below 202305.
						params: { edgeType: 'COMPANY_FOLLOWED_BY_MEMBER' },
						endpointLabel: 'linkedin.networkSizes'
					}
				),
				this.linkedinApiService.get<{ elements?: Array<{ totalPageStatistics?: any }> }>(
					'/organizationPageStatistics',
					{
						params: { q: 'organization', organization: organizationUrn },
						endpointLabel: 'linkedin.organizationPageStatistics.lifetime'
					}
				)
			]);

			const followerCount = networkSize?.firstDegreeSize ?? null;
			const totalPageViews =
				pageStats?.elements?.[0]?.totalPageStatistics?.views?.allPageViews?.pageViews ?? null;

			const snapshot = await this.linkedinOrganizationStatsRepo.create({
				organizationUrn,
				followerCount,
				totalPageViews,
				fetchedAt: new Date()
			});

			const hasData = followerCount !== null || totalPageViews !== null;
			const result = {
				statusCode: HttpStatus.OK,
				message: 'LinkedIn organization overview fetched successfully',
				data: { organizationUrn, followerCount, totalPageViews, fetchedAt: snapshot.fetchedAt }
			};
			this.setCache(cacheKey, result, 10 * 60_000);
			await this.dataCoverageService.recordAttempt({
				platform: 'linkedin',
				jobType: 'organization_overview',
				metricKey,
				success: hasData,
				status: hasData ? undefined : 'unavailable_insufficient_data',
				reason: hasData ? undefined : 'LinkedIn returned no follower/page-view data'
			});
			return result;
		} catch (err) {
			logToErrorFile(err, 'Error while fetching LinkedIn organization overview');
			await this.recordCoverageFailure('organization_overview', metricKey, err);
			throw new BadGatewayException(
				`Unable to fetch LinkedIn organization overview: ${this.describeError(err)}`
			);
		}
	}

	/** Lifetime follower statistics, segmented by the 7 professional-demographic facets. */
	async getFollowerStatistics() {
		const cacheKey = 'linkedin:follower-statistics';
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const metricKey = 'linkedin.followers.statistics';
		try {
			const { organizationUrn } = await this.linkedinAuthService.getAccessToken();
			const response = await this.linkedinApiService.get<{ elements?: Array<Record<string, any>> }>(
				'/organizationalEntityFollowerStatistics',
				{
					params: { q: 'organizationalEntity', organizationalEntity: organizationUrn },
					endpointLabel: 'linkedin.organizationalEntityFollowerStatistics.lifetime'
				}
			);

			const element = response?.elements?.[0] || {};
			const capturedAt = new Date();
			let rowsUpserted = 0;

			for (const facet of FOLLOWER_FACETS) {
				const facetRows: any[] = element[facet] || [];
				for (const row of facetRows) {
					const facetKey =
						row.geo ||
						row.function ||
						row.industry ||
						row.seniority ||
						row.staffCountRange ||
						row.associationType ||
						'unknown';

					await this.linkedinFollowerStatsRepo.create({
						organizationUrn,
						facet,
						facetKey,
						organicFollowerCount: row.followerCounts?.organicFollowerCount ?? 0,
						paidFollowerCount: row.followerCounts?.paidFollowerCount ?? 0,
						capturedAt
					});
					rowsUpserted++;
				}
			}

			const result = {
				statusCode: HttpStatus.OK,
				message: 'LinkedIn follower statistics fetched successfully',
				data: { organizationUrn, facets: element, capturedAt }
			};
			this.setCache(cacheKey, result, 10 * 60_000);
			await this.dataCoverageService.recordAttempt({
				platform: 'linkedin',
				jobType: 'follower_statistics',
				metricKey,
				success: rowsUpserted > 0,
				status: rowsUpserted > 0 ? undefined : 'unavailable_insufficient_data',
				reason: rowsUpserted > 0 ? undefined : 'LinkedIn returned no follower demographic rows'
			});
			return result;
		} catch (err) {
			logToErrorFile(err, 'Error while fetching LinkedIn follower statistics');
			await this.recordCoverageFailure('follower_statistics', metricKey, err);
			throw new BadGatewayException(
				`Unable to fetch LinkedIn follower statistics: ${this.describeError(err)}`
			);
		}
	}

	/** Time-bound (daily) page view statistics for the given range, defaulting to the last 30 days. */
	async getPageStatistics(startDate?: string, endDate?: string) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const cacheKey = `linkedin:page-statistics:${range.startDate}:${range.endDate}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const metricKey = 'linkedin.page.statistics';
		try {
			const { organizationUrn } = await this.linkedinAuthService.getAccessToken();
			const startMs = new Date(`${range.startDate}T00:00:00Z`).getTime();
			const endMs = new Date(`${range.endDate}T23:59:59Z`).getTime();

			const response = await this.linkedinApiService.get<{
				elements?: Array<{ timeRange: { start: number; end: number }; totalPageStatistics?: any }>;
			}>('/organizationPageStatistics', {
				params: {
					q: 'organization',
					organization: organizationUrn,
					timeIntervals: this.linkedinApiService.buildTimeIntervalsParam(startMs, endMs, 'DAY')
				},
				endpointLabel: 'linkedin.organizationPageStatistics.timeBound'
			});

			const elements = response?.elements || [];
			for (const element of elements) {
				const views = element.totalPageStatistics?.views || {};
				await this.linkedinPageStatsRepo.create({
					organizationUrn,
					statDate: new Date(element.timeRange.start).toISOString().slice(0, 10),
					allPageViews: views.allPageViews?.pageViews ?? 0,
					desktopPageViews: views.allDesktopPageViews?.pageViews ?? 0,
					mobilePageViews: views.allMobilePageViews?.pageViews ?? 0,
					careersPageViews: views.careersPageViews?.pageViews ?? 0,
					uniquePageViews: views.allPageViews?.uniquePageViews ?? null,
					fetchedAt: new Date()
				});
			}

			const result = {
				statusCode: HttpStatus.OK,
				message: 'LinkedIn page statistics fetched successfully',
				data: { organizationUrn, range, rows: elements.length },
				range
			};
			this.setCache(cacheKey, result, 10 * 60_000);
			await this.dataCoverageService.recordAttempt({
				platform: 'linkedin',
				jobType: 'page_statistics',
				metricKey,
				success: elements.length > 0,
				status: elements.length > 0 ? undefined : 'unavailable_insufficient_data',
				reason: elements.length > 0 ? undefined : 'LinkedIn returned no page-view rows for this range'
			});
			return result;
		} catch (err) {
			logToErrorFile(err, 'Error while fetching LinkedIn page statistics');
			await this.recordCoverageFailure('page_statistics', metricKey, err);
			throw new BadGatewayException(`Unable to fetch LinkedIn page statistics: ${this.describeError(err)}`);
		}
	}

	/**
	 * Time-bound (daily) organic share/post engagement, aggregated across all posts for the
	 * given range. Per-post breakdown (specific share/ugcPost URNs) needs the organization's
	 * list of post URNs first (the Posts API) — that's a natural next extension once this is
	 * live, deliberately left out of this initial scaffold.
	 */
	async getShareStatistics(startDate?: string, endDate?: string) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const cacheKey = `linkedin:share-statistics:${range.startDate}:${range.endDate}`;
		const cached = this.getFromCache(cacheKey);
		if (cached) return cached;

		const metricKey = 'linkedin.shares.statistics';
		try {
			const { organizationUrn } = await this.linkedinAuthService.getAccessToken();
			const startMs = new Date(`${range.startDate}T00:00:00Z`).getTime();
			const endMs = new Date(`${range.endDate}T23:59:59Z`).getTime();

			const response = await this.linkedinApiService.get<{
				elements?: Array<{ timeRange?: { start: number }; totalShareStatistics?: any }>;
			}>('/organizationalEntityShareStatistics', {
				params: {
					q: 'organizationalEntity',
					organizationalEntity: organizationUrn,
					timeIntervals: this.linkedinApiService.buildTimeIntervalsParam(startMs, endMs, 'DAY')
				},
				endpointLabel: 'linkedin.organizationalEntityShareStatistics.timeBound'
			});

			const elements = response?.elements || [];
			for (const element of elements) {
				const stats = element.totalShareStatistics || {};
				await this.linkedinShareStatsRepo.create({
					organizationUrn,
					shareUrn: null,
					ugcPostUrn: null,
					impressionCount: stats.impressionCount ?? 0,
					uniqueImpressionsCount: stats.uniqueImpressionsCount ?? null,
					clickCount: stats.clickCount ?? 0,
					likeCount: stats.likeCount ?? 0,
					commentCount: stats.commentCount ?? 0,
					shareCount: stats.shareCount ?? 0,
					engagement: stats.engagement !== undefined ? String(stats.engagement) : null,
					capturedAt: element.timeRange?.start ? new Date(element.timeRange.start) : new Date()
				});
			}

			const result = {
				statusCode: HttpStatus.OK,
				message: 'LinkedIn share statistics fetched successfully',
				data: { organizationUrn, range, rows: elements.length },
				range
			};
			this.setCache(cacheKey, result, 10 * 60_000);
			await this.dataCoverageService.recordAttempt({
				platform: 'linkedin',
				jobType: 'share_statistics',
				metricKey,
				success: elements.length > 0,
				status: elements.length > 0 ? undefined : 'unavailable_insufficient_data',
				reason: elements.length > 0 ? undefined : 'LinkedIn returned no share-engagement rows for this range'
			});
			return result;
		} catch (err) {
			logToErrorFile(err, 'Error while fetching LinkedIn share statistics');
			await this.recordCoverageFailure('share_statistics', metricKey, err);
			throw new BadGatewayException(`Unable to fetch LinkedIn share statistics: ${this.describeError(err)}`);
		}
	}

	private describeError(err: any) {
		// LinkedinAuthService throws plain Errors (not axios errors) for "not configured yet" /
		// "needs re-authorization" — those messages are already actionable, so surface them as-is
		// rather than falling through to the generic LinkedIn API error message.
		if (err instanceof Error && !err['response']) {
			return err.message;
		}
		return this.linkedinApiService.getErrorMessage(err);
	}

	private async recordCoverageFailure(jobType: string, metricKey: string, err: any) {
		await this.dataCoverageService.recordAttempt({
			platform: 'linkedin',
			jobType,
			metricKey,
			success: false,
			status: 'unavailable_unsupported',
			reason: this.describeError(err)
		});
	}

	private resolveDateRange(startDate?: string, endDate?: string, defaultDays = 30) {
		if (startDate && endDate) {
			return { startDate, endDate };
		}
		const end = new Date();
		const start = new Date();
		start.setDate(end.getDate() - defaultDays);
		return {
			startDate: start.toISOString().slice(0, 10),
			endDate: end.toISOString().slice(0, 10)
		};
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
