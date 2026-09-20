import {
	MetaAudienceGeoStats,
	MetaContentMetricSnapshots,
	MetaFacebookPageInsights,
	MetaGeoLocations,
	MetaFacebookPages,
	MetaFacebookPosts,
	MetaInstagramMedia,
	MetaInstagramProfiles,
	MetaVideoGeoStats
} from '../../../database/entity';
import { BadRequestException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { getName as getCountryName } from 'country-list';
import { Op } from 'sequelize';
import { MetaApiService } from './meta-api.service';
import { MetaAuthService } from './meta-auth.service';

type MetaPlatform = 'all' | 'facebook' | 'instagram';

@Injectable()
export class MetaDashboardService {
	private readonly logger = new Logger(MetaDashboardService.name);
	private readonly unsupportedInstagramMediaMetricsByType = new Map<string, Set<string>>();

	constructor(
		private readonly metaAuthService: MetaAuthService,
		private readonly metaApiService: MetaApiService,
		@Inject('META_FACEBOOK_PAGES_REPOSITORY')
		private readonly metaFacebookPagesRepo: typeof MetaFacebookPages,
		@Inject('META_FACEBOOK_POSTS_REPOSITORY')
		private readonly metaFacebookPostsRepo: typeof MetaFacebookPosts,
		@Inject('META_CONTENT_METRIC_SNAPSHOTS_REPOSITORY')
		private readonly metaContentMetricSnapshotsRepo: typeof MetaContentMetricSnapshots,
		@Inject('META_INSTAGRAM_PROFILES_REPOSITORY')
		private readonly metaInstagramProfilesRepo: typeof MetaInstagramProfiles,
		@Inject('META_INSTAGRAM_MEDIA_REPOSITORY')
		private readonly metaInstagramMediaRepo: typeof MetaInstagramMedia,
		@Inject('META_AUDIENCE_GEO_STATS_REPOSITORY')
		private readonly metaAudienceGeoStatsRepo: typeof MetaAudienceGeoStats,
		@Inject('META_FACEBOOK_PAGE_INSIGHTS_REPOSITORY')
		private readonly metaFacebookPageInsightsRepo: typeof MetaFacebookPageInsights,
		@Inject('META_VIDEO_GEO_STATS_REPOSITORY')
		private readonly metaVideoGeoStatsRepo: typeof MetaVideoGeoStats,
		@Inject('META_GEO_LOCATIONS_REPOSITORY')
		private readonly metaGeoLocationsRepo: typeof MetaGeoLocations
	) {}

	async getDashboardOverview(
		startDate?: string,
		endDate?: string,
		platform?: string
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const safePlatform = this.resolveMetaPlatform(platform);
		const [pages, profiles, facebookPosts, instagramMedia] = await Promise.all([
			this.metaFacebookPagesRepo.findAll({ raw: true }),
			this.metaInstagramProfilesRepo.findAll({ raw: true }),
			safePlatform === 'instagram'
				? Promise.resolve([])
				: this.metaFacebookPostsRepo.findAll({
					where: {
						createdTime: {
							[Op.between]: this.resolveDateTimeRange(range.startDate, range.endDate)
						}
					},
					raw: true
				}),
			safePlatform === 'facebook'
				? Promise.resolve([])
				: this.metaInstagramMediaRepo.findAll({
					where: {
						timestamp: {
							[Op.between]: this.resolveDateTimeRange(range.startDate, range.endDate)
						}
					},
					raw: true
				})
		]);

		const normalizedRows = [
			...facebookPosts.map((row: any) => this.normalizeFacebookPost(row, pages)),
			...instagramMedia.map((row: any) => this.normalizeInstagramMedia(row, profiles))
		];

		const totals = normalizedRows.reduce(
			(acc, row) => {
				acc.contentCount += 1;
				acc.views += Number(row.views ?? 0);
				acc.reach += Number(row.reach ?? 0);
				acc.impressions += Number(row.impressions ?? 0);
				acc.engagement += Number(row.engagement ?? 0);
				acc.likes += Number(row.likes ?? 0);
				acc.comments += Number(row.comments ?? 0);
				acc.shares += Number(row.shares ?? 0);
				acc.saved += Number(row.saved ?? 0);
				return acc;
			},
			{
				contentCount: 0,
				views: 0,
				reach: 0,
				impressions: 0,
				engagement: 0,
				likes: 0,
				comments: 0,
				shares: 0,
				saved: 0
			}
		);
		const instagramOverviewFallbackApplied = await this.applyInstagramOverviewFallback(
			totals,
			safePlatform,
			instagramMedia
		);

		const profileSummary = {
			facebookPages: pages.length,
			instagramProfiles: profiles.length,
			facebookFollowers: pages.reduce(
				(sum: number, row: any) => sum + Number(row.followers ?? 0),
				0
			),
			facebookFans: pages.reduce(
				(sum: number, row: any) => sum + Number(row.fans ?? 0),
				0
			),
			facebookPostCount: facebookPosts.length,
			instagramFollowers: profiles.reduce(
				(sum: number, row: any) => sum + Number(row.followers ?? 0),
				0
			),
			instagramMediaCount: profiles.reduce(
				(sum: number, row: any) => sum + Number(row.mediaCount ?? 0),
				0
			),
			instagramPostCount: instagramMedia.length
		};

		const timeseriesMap = new Map<string, any>();
		for (const row of normalizedRows) {
			const key = String(row.publishedDate || '');
			if (!key) continue;
			const existing = timeseriesMap.get(key) || {
				date: key,
				contentCount: 0,
				views: 0,
				reach: 0,
				impressions: 0,
				engagement: 0
			};
			existing.contentCount += 1;
			existing.views += Number(row.views ?? 0);
			existing.reach += Number(row.reach ?? 0);
			existing.impressions += Number(row.impressions ?? 0);
			existing.engagement += Number(row.engagement ?? 0);
			timeseriesMap.set(key, existing);
		}

		return {
			statusCode: HttpStatus.OK,
			message: 'Meta dashboard overview fetched successfully',
			range,
			platform: safePlatform,
			generatedAt: new Date().toISOString(),
			data: {
				profiles: profileSummary,
				totals,
				totalsSource: instagramOverviewFallbackApplied ? 'meta_live_fallback' : 'database',
				series: Array.from(timeseriesMap.values()).sort((a, b) =>
					String(a.date).localeCompare(String(b.date))
				)
			}
		};
	}

	async getDashboardContentTable(
		startDate?: string,
		endDate?: string,
		platform?: string,
		assetType?: string,
		sortBy = 'engagement',
		order: 'asc' | 'desc' = 'desc',
		page?: number,
		limit?: number
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const safePlatform = this.resolveMetaPlatform(platform);
		const safeAssetType = this.resolveContentAssetTypeFilter(assetType);
		const safeSortBy = this.resolveContentSortBy(sortBy);
		const safeOrder = String(order).toLowerCase() === 'asc' ? 'asc' : 'desc';
		const pagination = this.resolvePagination(page, limit, 10, 100);

		const [pages, profiles, facebookPosts, instagramMedia] = await Promise.all([
			this.metaFacebookPagesRepo.findAll({ raw: true }),
			this.metaInstagramProfilesRepo.findAll({ raw: true }),
			safePlatform === 'instagram'
				? Promise.resolve([])
				: this.metaFacebookPostsRepo.findAll({
					where: {
						createdTime: {
							[Op.between]: this.resolveDateTimeRange(range.startDate, range.endDate)
						}
					},
					raw: true
				}),
			safePlatform === 'facebook'
				? Promise.resolve([])
				: this.metaInstagramMediaRepo.findAll({
					where: {
						timestamp: {
							[Op.between]: this.resolveDateTimeRange(range.startDate, range.endDate)
						}
					},
					raw: true
				})
		]);

		const rows = [
			...facebookPosts.map((row: any) => this.normalizeFacebookPost(row, pages)),
			...instagramMedia.map((row: any) => this.normalizeInstagramMedia(row, profiles))
		]
			.filter((row) => this.matchesContentAssetTypeFilter(row, safeAssetType))
			.sort((a, b) => this.sortRowsByKey(a, b, safeSortBy, safeOrder))
			.map((row, index) => ({
				...row,
				rank: index + 1
			}));

		const pagedRows = pagination.shouldPaginate
			? rows.slice(pagination.offset, pagination.offset + pagination.limit)
			: rows;

		return {
			statusCode: HttpStatus.OK,
			message: 'Meta dashboard content table fetched successfully',
			range,
			platform: safePlatform,
			assetType: safeAssetType,
			sortBy: safeSortBy,
			order: safeOrder,
			data: {
				rows: pagedRows
			},
			pagination: {
				page: pagination.page,
				limit: pagination.limit,
				total: rows.length,
				totalPages: rows.length ? Math.ceil(rows.length / pagination.limit) : 0
			}
		};
	}

	async getContentDetail(
		platform?: string,
		assetId?: string,
		startDate?: string,
		endDate?: string,
		metric?: string,
		geoType?: string
	) {
		const safePlatform = this.resolveSinglePlatform(platform);
		if (!assetId) {
			throw new BadRequestException('assetId is required');
		}

		const range = this.resolveDateRange(startDate, endDate, 30);
		const normalizedRow = safePlatform === 'facebook'
			? await this.getSingleFacebookPost(assetId)
			: await this.getSingleInstagramMedia(assetId);

		if (!normalizedRow) {
			throw new BadRequestException('Meta asset not found');
		}

		const history = await this.getContentHistoryRows(
			safePlatform,
			assetId,
			range,
			normalizedRow.publishedAt
		);

		const safeMetric = this.resolveGeoMetric(metric);
		const safeGeoType = String(geoType || 'country').toLowerCase();
		let geoRows: any[] = await this.metaVideoGeoStatsRepo.findAll({
			where: {
				platform: safePlatform,
				assetId,
				metric: safeMetric,
				geoType: safeGeoType,
				startDate: range.startDate,
				endDate: range.endDate
			},
			order: [['value', 'DESC']],
			raw: true
		});
		let geoScope: 'asset' | 'account_audience' = 'asset';
		if (!geoRows.length && normalizedRow.accountId) {
			geoRows = await this.metaAudienceGeoStatsRepo.findAll({
				where: {
					platform: safePlatform,
					assetId: normalizedRow.accountId,
					metric: 'followers',
					geoType: safeGeoType,
					startDate: range.startDate,
					endDate: range.endDate
				},
				order: [['value', 'DESC']],
				raw: true
			});
			if (geoRows.length) {
				geoScope = 'account_audience';
			}
		}

		return {
			statusCode: HttpStatus.OK,
			message: 'Meta content detail fetched successfully',
			range,
			platform: safePlatform,
			assetId,
			data: {
				overview: normalizedRow,
				history,
				tags: this.buildTagListFromText(normalizedRow.caption || normalizedRow.title || ''),
				geoScope,
				geo: geoRows
			}
		};
	}

	async getTagDetail(
		tag?: string,
		startDate?: string,
		endDate?: string,
		platform?: string,
		page?: number,
		limit?: number
	) {
		const normalizedTag = this.normalizeTag(tag);
		if (!normalizedTag) {
			throw new BadRequestException('tag is required');
		}

		const range = this.resolveDateRange(startDate, endDate, 30);
		const safePlatform = this.resolveMetaPlatform(platform);
		const pagination = this.resolvePagination(page, limit, 10, 100);
		const rows = await this.getNormalizedContentRows(range, safePlatform);
		const matchingRows = rows.filter((row) =>
			(row.tags || []).some((item: string) => this.normalizeTag(item) === normalizedTag)
		);

		const summary = {
			tag: matchingRows.flatMap((row) => row.tags || []).find((item: string) => this.normalizeTag(item) === normalizedTag) || normalizedTag,
			contentCount: matchingRows.length,
			views: matchingRows.reduce((sum, row) => sum + Number(row.views ?? 0), 0),
			reach: matchingRows.reduce((sum, row) => sum + Number(row.reach ?? 0), 0),
			impressions: matchingRows.reduce((sum, row) => sum + Number(row.impressions ?? 0), 0),
			engagement: matchingRows.reduce((sum, row) => sum + Number(row.engagement ?? 0), 0),
			interactions: matchingRows.reduce((sum, row) => sum + Number(row.interactions ?? 0), 0),
			likes: matchingRows.reduce((sum, row) => sum + Number(row.likes ?? 0), 0),
			comments: matchingRows.reduce((sum, row) => sum + Number(row.comments ?? 0), 0),
			shares: matchingRows.reduce((sum, row) => sum + Number(row.shares ?? 0), 0),
			saved: matchingRows.reduce((sum, row) => sum + Number(row.saved ?? 0), 0),
			engagementRateReach: matchingRows.reduce(
				(sum, row) => sum + (this.hasMetricForEngagementRate(row) ? Number(row.reach ?? 0) : 0),
				0
			)
		};
		const geoBreakdown = await this.buildTagGeoAudienceBreakdown(matchingRows, range, safePlatform);
		const contentRows = matchingRows
			.sort((a, b) => this.sortRowsByKey(a, b, 'engagement', 'desc'))
			.map((row, index) => ({
				...row,
				rank: index + 1
			}));
		const pagedRows = pagination.shouldPaginate
			? contentRows.slice(pagination.offset, pagination.offset + pagination.limit)
			: contentRows;

		return {
			statusCode: HttpStatus.OK,
			message: 'Meta tag detail fetched successfully',
			range,
			platform: safePlatform,
			tag: summary.tag,
			data: {
				summary: {
					tag: summary.tag,
					contentCount: summary.contentCount,
					views: summary.views,
					reach: summary.reach,
					impressions: summary.impressions,
					engagement: summary.engagement,
					interactions: summary.interactions,
					likes: summary.likes,
					comments: summary.comments,
					shares: summary.shares,
					saved: summary.saved,
					engagementRatePercent: summary.engagementRateReach
						? Number(((summary.engagement / summary.engagementRateReach) * 100).toFixed(2))
						: null
				},
				topAudienceCountries: geoBreakdown.slice(0, 10),
				rows: pagedRows
			},
			pagination: {
				page: pagination.page,
				limit: pagination.limit,
				total: contentRows.length,
				totalPages: contentRows.length ? Math.ceil(contentRows.length / pagination.limit) : 0
			}
		};
	}

	async getGeoBreakdown(
		startDate?: string,
		endDate?: string,
		platform?: string,
		geoType?: string,
		metric?: string
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const safePlatform = this.resolveMetaPlatform(platform);
		const safeGeoType = String(geoType || 'country').toLowerCase();
		const requestedMetric = this.resolveAudienceGeoMetric(metric);
		const baseWhere = {
			...(safePlatform === 'all' ? {} : { platform: safePlatform }),
			geoType: safeGeoType,
			metric: {
				[Op.in]: ['followers', 'engaged_audience', 'reached_audience']
			}
		};
		let rows = await this.metaAudienceGeoStatsRepo.findAll({
			where: {
				...baseWhere,
				startDate: range.startDate,
				endDate: range.endDate
			},
			raw: true
		});

		let dataSource: 'requested_range' | 'latest_snapshot' = 'requested_range';
		let actualRange: { startDate: string; endDate: string } = range;

		if (!rows.length) {
			const fallbackSnapshotFilters = await this.resolveLatestAudienceGeoSnapshotFilters(
				baseWhere,
				safePlatform
			);
			if (fallbackSnapshotFilters.length) {
				rows = await this.metaAudienceGeoStatsRepo.findAll({
					where: {
						...baseWhere,
						[Op.or]: fallbackSnapshotFilters
					},
					raw: true
				});
				if (rows.length) {
					dataSource = 'latest_snapshot';
					const fallbackRange: { startDate: string; endDate: string } = {
						startDate: fallbackSnapshotFilters[0].startDate,
						endDate: fallbackSnapshotFilters[0].endDate
					};
					for (const filter of fallbackSnapshotFilters) {
						fallbackRange.startDate =
							filter.startDate < fallbackRange.startDate ? filter.startDate : fallbackRange.startDate;
						fallbackRange.endDate =
							filter.endDate > fallbackRange.endDate ? filter.endDate : fallbackRange.endDate;
					}
					actualRange = fallbackRange;
				}
			}
		}

		let facebookSnapshotAsOf: string | null = null;
		const hasFacebookRows = rows.some((row: any) => String(row.platform) === 'facebook');
		if (
			requestedMetric === 'followers' &&
			((safePlatform === 'facebook' && !rows.length) || (safePlatform === 'all' && !hasFacebookRows))
		) {
			const facebookFallbackRows = await this.buildFacebookAudienceGeoRowsFromPageInsights(safeGeoType);
			if (facebookFallbackRows.length) {
				facebookSnapshotAsOf = this.toDateOnly(new Date()) ?? range.endDate;
				dataSource = 'latest_snapshot';
				if (safePlatform === 'facebook') {
					actualRange = { startDate: facebookSnapshotAsOf, endDate: facebookSnapshotAsOf };
				}
			}
			rows = safePlatform === 'all' ? rows.concat(facebookFallbackRows) : facebookFallbackRows;
		}

		const locationMap = await this.getGeoLocationMap(rows.map((row: any) => String(row.geoKey || '')), safeGeoType);
		const aggregateMap = new Map<string, any>();
		for (const row of rows) {
			const geoKey = String(row.geoKey || '');
			if (!geoKey) continue;
			const key = `${row.platform}:${geoKey}`;
			const existing = aggregateMap.get(key) || {
				platform: row.platform,
				geoType: safeGeoType,
				geoKey,
				geoName: this.resolveGeoDisplayName(
					geoKey,
					safeGeoType,
					locationMap.get(geoKey)?.geoName,
					row.geoName
				),
				lat: locationMap.get(geoKey)?.latitude ?? null,
				lng: locationMap.get(geoKey)?.longitude ?? null,
				followers: 0,
				engagedAudience: 0,
				reachedAudience: 0,
				value: 0,
				assetCount: 0,
				assetIds: new Set<string>()
			};
			const normalizedMetric = String(row.metric || '').toLowerCase();
			const numericValue = Number(row.value ?? 0);
			if (normalizedMetric === 'followers') {
				existing.followers += numericValue;
			}
			if (normalizedMetric === 'engaged_audience') {
				existing.engagedAudience += numericValue;
			}
			if (normalizedMetric === 'reached_audience') {
				existing.reachedAudience += numericValue;
			}
			if (row.assetId) {
				existing.assetIds.add(String(row.assetId));
			}
			aggregateMap.set(key, existing);
		}

		const aggregatedRows = Array.from(aggregateMap.values()).map((row) => {
			const primaryValue =
				requestedMetric === 'engaged_audience'
					? Number(row.engagedAudience ?? 0)
					: requestedMetric === 'reached_audience'
						? Number(row.reachedAudience ?? 0)
						: Number(row.followers ?? 0);
			return {
				...row,
				value: primaryValue,
				metric: requestedMetric,
				assetCount: row.assetIds.size
			};
		});

		const totalValue = aggregatedRows.reduce(
			(sum, row) => sum + Number(row.value ?? 0),
			0
		);
		const sortedRows = aggregatedRows
			.sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0))
			.map((row, index) => ({
				...row,
				sharePercent: totalValue > 0 ? Number(((Number(row.value ?? 0) / totalValue) * 100).toFixed(2)) : 0,
				rank: index + 1
			}))
			.map(({ assetIds, ...row }) => row);

		return {
			statusCode: HttpStatus.OK,
			message: 'Meta geo breakdown fetched successfully',
			range,
			dataWindow: {
				requestedRange: range,
				actualRange,
				source: dataSource,
				facebookSnapshotAsOf
			},
			platform: safePlatform,
			geoType: safeGeoType,
			metric: requestedMetric,
			data: sortedRows
		};
	}

	private async resolveLatestAudienceGeoSnapshotFilters(
		baseWhere: Record<string, unknown>,
		platform: MetaPlatform
	) {
		const candidateRows = await this.metaAudienceGeoStatsRepo.findAll({
			where: baseWhere,
			raw: true,
			order: [
				['fetchedAt', 'DESC'],
				['endDate', 'DESC'],
				['startDate', 'DESC']
			]
		});

		if (!candidateRows.length) {
			return [];
		}

		if (platform !== 'all') {
			const latest = candidateRows.find(
				(row: any) => String(row.startDate || '').trim() && String(row.endDate || '').trim()
			);
			return latest
				? [{ startDate: latest.startDate, endDate: latest.endDate }]
				: [];
		}

		const latestByPlatform = new Map<string, { platform: string; startDate: string; endDate: string }>();
		for (const row of candidateRows) {
			const rowPlatform = String(row.platform || '').trim();
			const rowStartDate = String(row.startDate || '').trim();
			const rowEndDate = String(row.endDate || '').trim();
			if (!rowPlatform || !rowStartDate || !rowEndDate || latestByPlatform.has(rowPlatform)) {
				continue;
			}

			latestByPlatform.set(rowPlatform, {
				platform: rowPlatform,
				startDate: rowStartDate,
				endDate: rowEndDate
			});
		}

		return Array.from(latestByPlatform.values());
	}

	private async buildFacebookAudienceGeoRowsFromPageInsights(geoType: string) {
		const metric = geoType === 'city' ? 'page_fans_city' : 'page_fans_country';
		const candidateRows = await this.metaFacebookPageInsightsRepo.findAll({
			where: { metric },
			raw: true,
			order: [
				['updatedAt', 'DESC'],
				['createdAt', 'DESC']
			]
		});

		if (!candidateRows.length) {
			return [];
		}

		const latestByPageId = new Map<string, any>();
		for (const row of candidateRows) {
			const pageId = String(row.pageId || '').trim();
			if (!pageId || latestByPageId.has(pageId)) {
				continue;
			}
			latestByPageId.set(pageId, row);
		}

		const rows: any[] = [];
		for (const row of latestByPageId.values()) {
			for (const { geoKey, value } of this.extractFlatGeoEntries(this.parseMaybeJson(row.value))) {
				rows.push({
					platform: 'facebook',
					assetId: String(row.pageId || ''),
					geoType,
					geoKey,
					geoName: null,
					metric: 'followers',
					value: this.normalizeInsightValue(value) ?? 0
				});
			}
		}

		return rows;
	}

	private readonly facebookPageInsightMetricKeyByCandidate: Record<string, string> = {
		page_follows: 'pageFollows',
		page_fans: 'pageFollows',
		page_daily_follows_unique: 'dailyFollows',
		page_fan_adds_unique: 'dailyFollows',
		page_fan_adds: 'dailyFollows',
		page_daily_unfollows_unique: 'dailyUnfollows',
		page_fan_removes_unique: 'dailyUnfollows',
		page_fan_removes: 'dailyUnfollows',
		page_views_total: 'pageViewsTotal',
		page_post_engagements: 'pagePostEngagements',
		page_video_views: 'pageVideoViews',
		page_video_view_time: 'pageVideoViewTime',
		page_video_complete_views_30s: 'pageVideoCompleteViews30s',
		page_actions_post_reactions_total: 'reactionsByType'
	};

	async getFacebookPageInsightsTrends(startDate?: string, endDate?: string) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const rows = await this.metaFacebookPageInsightsRepo.findAll({
			where: {
				metric: { [Op.in]: Object.keys(this.facebookPageInsightMetricKeyByCandidate) },
				endTime: {
					[Op.between]: [range.startDate, range.endDate]
				}
			},
			order: [['endTime', 'ASC']],
			raw: true
		});

		const dailyMap = new Map<string, any>();
		for (const row of rows as any[]) {
			const canonicalKey = this.facebookPageInsightMetricKeyByCandidate[String(row.metric || '')];
			const date = this.toDateOnly(row.endTime);
			if (!canonicalKey || !date) continue;

			const pageId = String(row.pageId || '');
			const mapKey = `${pageId}:${date}`;
			const existing = dailyMap.get(mapKey) || {
				pageId,
				date,
				pageFollows: null,
				dailyFollows: null,
				dailyUnfollows: null,
				pageViewsTotal: null,
				pagePostEngagements: null,
				pageVideoViews: null,
				pageVideoViewTime: null,
				pageVideoCompleteViews30s: null,
				reactionsByType: null
			};

			const parsedValue = this.parseMaybeJson(row.value);
			existing[canonicalKey] =
				canonicalKey === 'reactionsByType' ? parsedValue : this.normalizeInsightValue(parsedValue);
			dailyMap.set(mapKey, existing);
		}

		const data = Array.from(dailyMap.values()).sort((a, b) =>
			a.date === b.date ? a.pageId.localeCompare(b.pageId) : a.date < b.date ? -1 : 1
		);

		return {
			statusCode: HttpStatus.OK,
			message: 'Facebook page insights trends fetched successfully',
			range,
			data
		};
	}

	async getOverallTagPerformance(
		startDate?: string,
		endDate?: string,
		platform?: string,
		sortBy = 'engagement',
		order: 'asc' | 'desc' = 'desc',
		page?: number,
		limit?: number
	) {
		const range = this.resolveDateRange(startDate, endDate, 30);
		const safePlatform = this.resolveMetaPlatform(platform);
		const safeSortBy = this.resolveTagSortBy(sortBy);
		const safeOrder = String(order).toLowerCase() === 'asc' ? 'asc' : 'desc';
		const pagination = this.resolvePagination(page, limit, 10, 100);

		const rows = await this.getNormalizedContentRows(range, safePlatform);
		const tagRows = this.buildTagAggregateRows(rows)
			.sort((a, b) => this.sortRowsByKey(a, b, safeSortBy, safeOrder))
			.map((row, index) => ({
				...row,
				rank: index + 1
			}));
		const pagedRows = pagination.shouldPaginate
			? tagRows.slice(pagination.offset, pagination.offset + pagination.limit)
			: tagRows;

		return {
			statusCode: HttpStatus.OK,
			message: 'Meta overall tag performance fetched successfully',
			range,
			platform: safePlatform,
			sortBy: safeSortBy,
			order: safeOrder,
			data: {
				rows: pagedRows
			},
			pagination: {
				page: pagination.page,
				limit: pagination.limit,
				total: tagRows.length,
				totalPages: tagRows.length ? Math.ceil(tagRows.length / pagination.limit) : 0
			}
		};
	}

	private async getNormalizedContentRows(
		range: { startDate: string; endDate: string },
		platform: MetaPlatform
	) {
		const [pages, profiles, facebookPosts, instagramMedia] = await Promise.all([
			this.metaFacebookPagesRepo.findAll({ raw: true }),
			this.metaInstagramProfilesRepo.findAll({ raw: true }),
			platform === 'instagram'
				? Promise.resolve([])
				: this.metaFacebookPostsRepo.findAll({
					where: {
						createdTime: {
							[Op.between]: this.resolveDateTimeRange(range.startDate, range.endDate)
						}
					},
					raw: true
				}),
			platform === 'facebook'
				? Promise.resolve([])
				: this.metaInstagramMediaRepo.findAll({
					where: {
						timestamp: {
							[Op.between]: this.resolveDateTimeRange(range.startDate, range.endDate)
						}
					},
					raw: true
				})
		]);

		return [
			...facebookPosts.map((row: any) => this.normalizeFacebookPost(row, pages)),
			...instagramMedia.map((row: any) => this.normalizeInstagramMedia(row, profiles))
		];
	}

	private normalizeFacebookPost(row: any, pages: any[]) {
		const page = pages.find((item: any) => String(item.pageId) === String(row.pageId));
		const text = String(row.message || '').trim();
		const title = text ? text.slice(0, 140) : `Facebook post ${row.postId}`;
		const rawJson = this.parseMaybeJson(row.rawJson);
		const thumbnail = this.extractFacebookThumbnail(rawJson);
		const permalink = row.permalink || rawJson?.permalink_url || null;
		const likes = Number(row.likes ?? 0);
		const comments = Number(row.comments ?? 0);
		const shares = Number(row.shares ?? 0);
		const interactions = this.toNullableNumber(row.interactions) ?? likes + comments + shares;
		const rawEngagementSource = String(row.engagementSource || '').trim().toLowerCase();
		const storedEngagement = this.toNullableNumber(row.engagement);
		const engagementSource =
			rawEngagementSource === 'meta'
				? 'meta'
				: storedEngagement !== null
					? rawEngagementSource || 'stored'
					: null;
		const engagement = storedEngagement ?? interactions;
		const reach = this.toNullableNumber(row.reach);
		const impressions = this.toNullableNumber(row.impressions);
		const views = this.toNullableNumber(row.videoViews);
		const videoAvgTimeWatchedMs = this.toNullableNumber(row.videoAvgTimeWatchedMs);
		const videoCompleteViews30s = this.toNullableNumber(row.videoCompleteViews30s);
		const reactionsByType = this.parseMaybeJson(row.reactionsByType);
		const videoRetentionGraph = this.parseMaybeJson(row.videoRetentionGraph);

		return {
			platform: 'facebook',
			assetType: String(row.type || row.statusType || 'post'),
			assetId: String(row.postId || ''),
			accountId: String(row.pageId || ''),
			accountName: String(page?.name || ''),
			title,
			caption: text || null,
			thumbnail,
			permalink,
			publishedAt: row.createdTime || null,
			publishedDate: this.toDateOnly(row.createdTime),
			views,
			reach,
			impressions,
			engagement,
			interactions,
			engagementSource,
			likes,
			comments,
			shares,
			saved: null,
			videoAvgTimeWatchedMs,
			videoCompleteViews30s,
			reactionsByType,
			videoRetentionGraph,
			engagementRatePercent:
				engagement !== null && reach !== null && reach > 0
					? Number(((engagement / reach) * 100).toFixed(2))
					: null,
			tags: this.buildTagListFromText(text),
			raw: row
		};
	}

	private extractFacebookThumbnail(rawJson: any): string | null {
		if (!rawJson) {
			return null;
		}

		return rawJson?.full_picture
			|| rawJson?.picture?.data?.url
			|| rawJson?.picture
			|| rawJson?.attachments?.data?.[0]?.media?.image?.src
			|| rawJson?.attachments?.data?.[0]?.subattachments?.data?.[0]?.media?.image?.src
			|| rawJson?.attachments?.data?.[0]?.url
			|| rawJson?.attachments?.data?.[0]?.subattachments?.data?.[0]?.url
			|| null;
	}

	private normalizeInstagramMedia(row: any, profiles: any[]) {
		const profile = profiles.find(
			(item: any) => String(item.instagramId) === String(row.instagramId)
		);
		const text = String(row.caption || '').trim();
		const title = text ? text.slice(0, 140) : `Instagram media ${row.mediaId}`;
		const likes = Number(row.likeCount ?? 0);
		const comments = Number(row.commentsCount ?? 0);
		const shares = Number(row.shares ?? 0);
		const saved = this.toNullableNumber(row.saved);
		const engagement = this.toNullableNumber(row.engagement) ?? likes + comments + Number(saved ?? 0);
		const interactions = likes + comments + Number(saved ?? 0);
		const reach = this.toNullableNumber(row.reach);
		const impressions = this.toNullableNumber(row.impressions);
		const views = this.toNullableNumber(row.videoViews);

		return {
			platform: 'instagram',
			assetType: String(row.mediaType || 'media').toLowerCase(),
			assetId: String(row.mediaId || ''),
			accountId: String(row.instagramId || ''),
			accountName: String(profile?.username || ''),
			title,
			caption: text || null,
			thumbnail: row.mediaUrl || null,
			permalink: row.permalink || null,
			publishedAt: row.timestamp || null,
			publishedDate: this.toDateOnly(row.timestamp),
			views,
			reach,
			impressions,
			engagement,
			interactions,
			engagementSource: 'meta',
			likes,
			comments,
			shares,
			saved,
			engagementRatePercent:
				reach !== null && reach > 0
					? Number(((engagement / reach) * 100).toFixed(2))
					: null,
			tags: this.buildTagListFromText(text),
			raw: row
		};
	}

	private async getSingleFacebookPost(assetId: string) {
		const [pages, row] = await Promise.all([
			this.metaFacebookPagesRepo.findAll({ raw: true }),
			this.metaFacebookPostsRepo.findOne({
				where: { postId: assetId },
				raw: true
			})
		]);
		return row ? this.normalizeFacebookPost(row, pages) : null;
	}

	private async getSingleInstagramMedia(assetId: string) {
		const [profiles, row] = await Promise.all([
			this.metaInstagramProfilesRepo.findAll({ raw: true }),
			this.metaInstagramMediaRepo.findOne({
				where: { mediaId: assetId },
				raw: true
			})
		]);
		return row ? this.normalizeInstagramMedia(row, profiles) : null;
	}

	private async getContentHistoryRows(
		platform: 'facebook' | 'instagram',
		assetId: string,
		range: { startDate: string; endDate: string },
		publishedAt?: Date | string | null
	) {
		const rows = await this.metaContentMetricSnapshotsRepo.findAll({
			where: {
				platform,
				assetId,
				snapshotDate: {
					[Op.between]: [range.startDate, range.endDate]
				}
			},
			order: [['snapshotDate', 'ASC']],
			raw: true
		});

		return rows.map((row: any) => {
			const snapshotDate = String(row.snapshotDate || '');
			const publishedDate = this.toDateOnly(publishedAt);
			return {
				date: snapshotDate,
				daysSincePublished: publishedDate
					? this.getInclusiveDateCount(publishedDate, snapshotDate) - 1
					: null,
				likes: this.toNullableNumber(row.likes),
				comments: this.toNullableNumber(row.comments),
				shares: this.toNullableNumber(row.shares),
				saved: this.toNullableNumber(row.saved),
				reach: this.toNullableNumber(row.reach),
				impressions: this.toNullableNumber(row.impressions),
				engagement: this.toNullableNumber(row.engagement),
				interactions: this.toNullableNumber(row.interactions),
				views: this.toNullableNumber(row.views),
				engagementSource:
					String(row.engagementSource || '').trim().toLowerCase() === 'meta'
						? 'meta'
						: null
			};
		});
	}

	private buildTagAggregateRows(rows: any[]) {
		const tagMap = new Map<string, any>();
		for (const row of rows) {
			for (const tag of row.tags || []) {
				const normalizedTag = this.normalizeTag(tag);
				if (!normalizedTag) continue;

				const existing = tagMap.get(normalizedTag) || {
					tag,
					normalizedTag,
					contentCount: 0,
					views: 0,
					reach: 0,
					impressions: 0,
					engagement: 0,
					interactions: 0,
					likes: 0,
					comments: 0,
					shares: 0,
					saved: 0,
					engagementRateReach: 0,
					topContent: []
				};

				existing.contentCount += 1;
				existing.views += Number(row.views ?? 0);
				existing.reach += Number(row.reach ?? 0);
				existing.impressions += Number(row.impressions ?? 0);
				existing.engagement += Number(row.engagement ?? 0);
				existing.interactions += Number(row.interactions ?? 0);
				existing.likes += Number(row.likes ?? 0);
				existing.comments += Number(row.comments ?? 0);
				existing.shares += Number(row.shares ?? 0);
				existing.saved += Number(row.saved ?? 0);
				if (this.hasMetricForEngagementRate(row)) {
					existing.engagementRateReach += Number(row.reach ?? 0);
				}
				existing.topContent.push({
					assetId: row.assetId,
					platform: row.platform,
					title: row.title,
					thumbnail: row.thumbnail,
					engagement: row.engagement,
					reach: row.reach
				});
				tagMap.set(normalizedTag, existing);
			}
		}

		return Array.from(tagMap.values()).map((row) => {
			const { engagementRateReach, ...rest } = row;
			return {
				...rest,
				engagementRatePercent: engagementRateReach
					? Number(((row.engagement / engagementRateReach) * 100).toFixed(2))
					: null,
				topContent: row.topContent
					.sort((a: any, b: any) => Number(b.engagement ?? 0) - Number(a.engagement ?? 0))
					.slice(0, 3)
			};
		});
	}

	private async buildTagGeoAudienceBreakdown(
		rows: any[],
		range: { startDate: string; endDate: string },
		platform: MetaPlatform
	) {
		const accountIds = Array.from(
			new Set(
				rows
					.filter((row) => platform === 'all' || row.platform === platform)
					.map((row) => String(row.accountId || ''))
					.filter(Boolean)
			)
		);
		if (!accountIds.length) {
			return [];
		}

		const geoRows = await this.metaAudienceGeoStatsRepo.findAll({
			where: {
				assetId: {
					[Op.in]: accountIds
				},
				geoType: 'country',
				metric: 'followers',
				startDate: range.startDate,
				endDate: range.endDate,
				...(platform === 'all' ? {} : { platform })
			},
			raw: true
		});
		const locationMap = await this.getGeoLocationMap(
			geoRows.map((row: any) => String(row.geoKey || '')),
			'country'
		);
		const aggregateMap = new Map<string, any>();
		for (const row of geoRows) {
			const geoKey = String(row.geoKey || '');
			if (!geoKey) continue;
			const existing = aggregateMap.get(geoKey) || {
				countryCode: geoKey,
				geoName: row.geoName || locationMap.get(geoKey)?.geoName || null,
				lat: locationMap.get(geoKey)?.latitude ?? null,
				lng: locationMap.get(geoKey)?.longitude ?? null,
				followers: 0,
				assetCount: 0
			};
			existing.followers += Number(row.value ?? 0);
			existing.assetCount += 1;
			aggregateMap.set(geoKey, existing);
		}

		return Array.from(aggregateMap.values()).sort(
			(a, b) => Number(b.followers ?? 0) - Number(a.followers ?? 0)
		);
	}

	private async applyInstagramOverviewFallback(
		totals: {
			contentCount: number;
			views: number;
			reach: number;
			impressions: number;
			engagement: number;
			likes: number;
			comments: number;
			shares: number;
			saved: number;
		},
		platform: MetaPlatform,
		instagramMediaRows: any[]
	) {
		if (!this.shouldApplyInstagramOverviewFallback(totals, platform, instagramMediaRows)) {
			return false;
		}

		try {
			const pageTokenRow = await this.metaAuthService.getEffectivePageToken();
			const fallbackTotals = await this.fetchInstagramOverviewTotalsFromMeta(
				instagramMediaRows,
				pageTokenRow.accessToken
			);
			if (!fallbackTotals) {
				return false;
			}

			totals.views = fallbackTotals.views;
			totals.reach = fallbackTotals.reach;
			totals.impressions = fallbackTotals.impressions;
			totals.engagement = fallbackTotals.engagement;
			totals.likes = fallbackTotals.likes;
			totals.comments = fallbackTotals.comments;
			totals.saved = fallbackTotals.saved;
			return true;
		} catch {
			return false;
		}
	}

	private shouldApplyInstagramOverviewFallback(
		totals: {
			views: number;
			reach: number;
			impressions: number;
			engagement: number;
		},
		platform: MetaPlatform,
		instagramMediaRows: any[]
	) {
		if (platform === 'facebook') {
			return false;
		}

		if (!instagramMediaRows.length) {
			return false;
		}

		return (
			Number(totals.views ?? 0) === 0 &&
			Number(totals.reach ?? 0) === 0 &&
			Number(totals.impressions ?? 0) === 0 &&
			Number(totals.engagement ?? 0) === 0
		);
	}

	private async fetchInstagramOverviewTotalsFromMeta(
		instagramMediaRows: any[],
		accessToken: string
	) {
		const totals = {
			views: 0,
			reach: 0,
			impressions: 0,
			engagement: 0,
			likes: 0,
			comments: 0,
			saved: 0
		};
		let hasLiveValues = false;

		for (const batch of this.chunkArray(instagramMediaRows, 10)) {
			const batchResults = await Promise.all(
				batch.map((row) =>
					this.fetchInstagramMediaOverviewMetrics(
						row,
						accessToken
					)
				)
			);

			for (const result of batchResults) {
				if (!result) {
					continue;
				}

				hasLiveValues =
					hasLiveValues ||
					result.views > 0 ||
					result.reach > 0 ||
					result.impressions > 0 ||
					result.engagement > 0;
				totals.views += result.views;
				totals.reach += result.reach;
				totals.impressions += result.impressions;
				totals.engagement += result.engagement;
				totals.likes += result.likes;
				totals.comments += result.comments;
				totals.saved += result.saved;
			}
		}

		return hasLiveValues ? totals : null;
	}

	private async fetchInstagramMediaOverviewMetrics(row: any, accessToken: string) {
		const mediaId = String(row?.mediaId || '').trim();
		if (!mediaId) {
			return null;
		}

		const mediaTypeValue = this.normalizeInstagramMediaTypeValue(row?.mediaType);
		const metricCandidates = this.buildInstagramMediaMetricCandidates(mediaTypeValue);

		for (const metrics of metricCandidates) {
			try {
				const response = await this.metaApiService.get<{
					data?: Array<{
						name?: string;
						values?: Array<{ value?: number | string | Record<string, unknown> }>;
					}>;
				}>(`/${mediaId}/insights`, {
					accessToken,
					params: {
						metric: metrics.join(',')
					},
					endpointLabel: 'instagram_media_insights_dashboard_fallback'
				});
				const insights = this.reduceMetaInsightRows(response.data || [], {
					engagement: ['total_interactions', 'engagement'],
					impressions: ['impressions'],
					reach: ['reach'],
					saved: ['saved'],
					videoViews: ['views', 'video_views', 'total_views']
				});
				const likes = Number(row?.likeCount ?? 0);
				const comments = Number(row?.commentsCount ?? 0);
				const saved = Number(insights.saved ?? 0);
				const engagementFallback = likes + comments + saved;

				return {
					views: Number(insights.videoViews ?? 0),
					reach: Number(insights.reach ?? 0),
					impressions: Number(row?.impressions ?? insights.impressions ?? 0),
					engagement: Number(insights.engagement ?? 0) || engagementFallback,
					likes,
					comments,
					saved
				};
			} catch (error: any) {
				if (metrics.includes('impressions') && this.isInvalidInstagramMediaMetricError(error)) {
					this.markInstagramMediaMetricUnsupported(mediaTypeValue, 'impressions');
					continue;
				}

				return null;
			}
		}

		return null;
	}

	private chunkArray<T>(rows: T[], size: number) {
		const chunks: T[][] = [];
		for (let index = 0; index < rows.length; index += size) {
			chunks.push(rows.slice(index, index + size));
		}
		return chunks;
	}

	private buildTagListFromText(text: string) {
		const matches = String(text || '').match(/#[\p{L}\p{N}_]+/gu) || [];
		const seen = new Set<string>();
		const tags: string[] = [];
		for (const tag of matches) {
			const normalizedTag = this.normalizeTag(tag);
			if (!normalizedTag || seen.has(normalizedTag)) continue;
			seen.add(normalizedTag);
			tags.push(tag);
		}
		return tags;
	}

	private normalizeTag(tag?: string) {
		return String(tag || '').trim().toLowerCase();
	}

	private resolveGeoDisplayName(
		geoKey: string,
		geoType: string,
		locationGeoName?: string | null,
		rowGeoName?: string | null
	) {
		const normalizedGeoKey = String(geoKey || '').trim();
		const preferredLocationName = String(locationGeoName || '').trim();
		if (preferredLocationName && preferredLocationName.toUpperCase() !== normalizedGeoKey.toUpperCase()) {
			return preferredLocationName;
		}

		if (geoType === 'country') {
			const countryName = getCountryName(normalizedGeoKey.toUpperCase());
			if (countryName) {
				return countryName;
			}
		}

		const normalizedRowGeoName = String(rowGeoName || '').trim();
		if (normalizedRowGeoName) {
			return normalizedRowGeoName;
		}

		return normalizedGeoKey || null;
	}

	private normalizeInstagramMediaTypeValue(mediaType?: string) {
		return String(mediaType || '').trim().toUpperCase() || 'UNKNOWN';
	}

	private buildInstagramMediaMetricCandidates(mediaType: string) {
		const fallbackMetrics = ['total_interactions', 'reach', 'saved'];
		if (mediaType === 'VIDEO' || mediaType === 'REELS') {
			fallbackMetrics.push('views');
		}

		if (this.isInstagramMediaMetricUnsupported(mediaType, 'impressions')) {
			return [fallbackMetrics];
		}

		return [[...fallbackMetrics, 'impressions'], fallbackMetrics];
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
			`Meta dashboard: Instagram media insight metric ${metricName} is not supported for media type ${mediaType}; retrying without it.`
		);
	}

	private reduceMetaInsightRows(
		rows: Array<{ name?: string; values?: Array<{ value?: number | string | Record<string, unknown> }> }>,
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

	private async getGeoLocationMap(geoKeys: string[], geoType: string) {
		const uniqueGeoKeys = Array.from(new Set(geoKeys.filter(Boolean)));
		if (!uniqueGeoKeys.length) {
			return new Map<string, any>();
		}

		const rows = await this.metaGeoLocationsRepo.findAll({
			where: {
				geoType,
				geoKey: {
					[Op.in]: uniqueGeoKeys
				}
			},
			raw: true
		});

		return new Map(rows.map((row: any) => [String(row.geoKey), row]));
	}

	private resolveMetaPlatform(platform?: string): MetaPlatform {
		const value = String(platform || 'all').toLowerCase();
		if (value === 'facebook' || value === 'instagram' || value === 'all') {
			return value as MetaPlatform;
		}
		return 'all';
	}

	private resolveSinglePlatform(platform?: string) {
		const value = String(platform || '').toLowerCase();
		if (value === 'facebook' || value === 'instagram') {
			return value;
		}
		throw new BadRequestException('platform must be facebook or instagram');
	}

	private resolveAudienceGeoMetric(metric?: string) {
		const value = String(metric || 'followers').toLowerCase();
		if (value === 'followers' || value === 'engaged_audience' || value === 'reached_audience') {
			return value;
		}
		throw new BadRequestException('metric must be followers, engaged_audience or reached_audience');
	}

	private resolveContentSortBy(sortBy?: string) {
		const allowed = new Set([
			'engagement',
			'views',
			'reach',
			'impressions',
			'likes',
			'comments',
			'shares',
			'saved',
			'publishedAt',
			'title'
		]);
		return allowed.has(String(sortBy || '')) ? String(sortBy) : 'engagement';
	}

	private resolveContentAssetTypeFilter(assetType?: string) {
		const value = String(assetType || 'all').trim().toLowerCase();
		return value || 'all';
	}

	private resolveTagSortBy(sortBy?: string) {
		const allowed = new Set([
			'engagement',
			'views',
			'reach',
			'impressions',
			'contentCount',
			'likes',
			'comments',
			'shares',
			'saved'
		]);
		return allowed.has(String(sortBy || '')) ? String(sortBy) : 'engagement';
	}

	private resolveGeoMetric(metric?: string) {
		const allowed = new Set(['views', 'followers']);
		return allowed.has(String(metric || '')) ? String(metric) : 'views';
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
		const safeLimit = Math.min(hasLimit ? Number(limit) : defaultLimit, maxLimit);
		return {
			shouldPaginate,
			page: safePage,
			limit: safeLimit,
			offset: (safePage - 1) * safeLimit
		};
	}

	private resolveDateRange(startDate?: string, endDate?: string, defaultDays = 30) {
		if (startDate && endDate) {
			return { startDate, endDate };
		}

		const end = new Date();
		const start = new Date();
		start.setDate(end.getDate() - defaultDays);
		return {
			startDate: this.toDateOnly(start),
			endDate: this.toDateOnly(end)
		};
	}

	private resolveDateTimeRange(startDate: string, endDate: string) {
		return [`${startDate}T00:00:00.000Z`, `${endDate}T23:59:59.999Z`];
	}

	private parseMaybeJson(value: any) {
		if (typeof value !== 'string') {
			return value;
		}
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}

	private extractFlatGeoEntries(rawValue: unknown): Array<{ geoKey: string; value: unknown }> {
		if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
			return [];
		}

		return Object.entries(rawValue as Record<string, unknown>)
			.map(([geoKey, value]) => ({
				geoKey: String(geoKey || '').trim(),
				value
			}))
			.filter((entry) => Boolean(entry.geoKey));
	}

	private toDateOnly(value: Date | string | null | undefined) {
		if (!value) return null;
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return null;
		return date.toISOString().slice(0, 10);
	}

	private getInclusiveDateCount(startDate: string, endDate: string) {
		const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
		const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
		if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
			return 0;
		}

		return Math.floor((end - start) / 86400000) + 1;
	}

	private toNullableNumber(value: unknown) {
		if (value === null || value === undefined || value === '') {
			return null;
		}

		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	private hasMetricForEngagementRate(row: Record<string, any>) {
		return row.engagement !== null && row.engagement !== undefined && row.reach !== null && row.reach !== undefined;
	}

	private sortRowsByKey(a: Record<string, any>, b: Record<string, any>, key: string, order: 'asc' | 'desc') {
		const aValue = a[key];
		const bValue = b[key];
		const normalizedA = typeof aValue === 'string' ? aValue.toLowerCase() : Number(aValue ?? 0);
		const normalizedB = typeof bValue === 'string' ? bValue.toLowerCase() : Number(bValue ?? 0);
		if (normalizedA === normalizedB) return 0;
		if (order === 'asc') return normalizedA > normalizedB ? 1 : -1;
		return normalizedA < normalizedB ? 1 : -1;
	}

	private matchesContentAssetTypeFilter(row: Record<string, any>, assetTypeFilter: string) {
		if (!assetTypeFilter || assetTypeFilter === 'all') {
			return true;
		}

		const normalizedAssetType = String(row?.assetType || '').trim().toLowerCase();
		if (!normalizedAssetType) {
			return false;
		}

		const groupedMatches: Record<string, string[]> = {
			image: ['image', 'photo'],
			video: ['video', 'reel', 'reels'],
			carousel: ['carousel_album', 'carousel', 'album'],
			link: ['link'],
			text: ['status', 'post']
		};

		if (groupedMatches[assetTypeFilter]?.includes(normalizedAssetType)) {
			return true;
		}

		return normalizedAssetType === assetTypeFilter;
	}
}
