import { BadGatewayException, Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import { createEmptyTierSummary } from '../../shared/utils/refresh-tiering';
import { MetaIngestService } from './meta-ingest.service';

// The file logger opens a rotating log stream at import time, which has no home under jest.
jest.mock('../../../common/logger', () => ({
	logToErrorFile: jest.fn()
}));

const REDUCE_DATA_MESSAGE =
	"Please reduce the amount of data you're asking for, then retry your request";

function graphError(message: string, code = 1) {
	return {
		message: 'Request failed with status code 500',
		response: { status: 500, data: { error: { message, code } }, headers: {} }
	};
}

describe('MetaIngestService', () => {
	let service: MetaIngestService;
	let metaApiService: { get: jest.Mock };
	let dataCoverageService: { recordAttempt: jest.Mock };
	let ingestionRunsService: {
		createRun: jest.Mock;
		heartbeatRun: jest.Mock;
		completeRun: jest.Mock;
		failRun: jest.Mock;
	};
	let metaAuthService: { getEffectivePageToken: jest.Mock };
	let metaIngestionRunsRepo: { create: jest.Mock };
	let accountInsightsRepo: { findOne: jest.Mock; create: jest.Mock };
	let cityListRepo: { count: jest.Mock; findAll: jest.Mock };

	beforeEach(() => {
		jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
		jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
		jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

		metaApiService = { get: jest.fn() };
		dataCoverageService = { recordAttempt: jest.fn().mockResolvedValue(undefined) };
		ingestionRunsService = {
			createRun: jest.fn().mockResolvedValue({ id: 99 }),
			heartbeatRun: jest.fn().mockResolvedValue(undefined),
			completeRun: jest.fn().mockResolvedValue(undefined),
			failRun: jest.fn().mockResolvedValue(undefined)
		};
		metaAuthService = {
			getEffectivePageToken: jest.fn().mockResolvedValue({
				pageId: '153145408089596',
				accessToken: 'page-token',
				instagramBusinessAccountId: '17841400714806415'
			})
		};
		metaIngestionRunsRepo = {
			create: jest.fn(async (payload) => ({
				id: 1,
				...payload,
				update: jest.fn().mockResolvedValue(undefined)
			}))
		};
		accountInsightsRepo = {
			findOne: jest.fn().mockResolvedValue(null),
			create: jest.fn().mockResolvedValue(undefined)
		};
		cityListRepo = {
			count: jest.fn().mockResolvedValue(1),
			findAll: jest.fn().mockResolvedValue([])
		};

		service = new MetaIngestService(
			metaAuthService as any,
			metaApiService as any,
			{ getUsageSnapshot: () => ({ percent: null, updatedAt: null }) } as any,
			ingestionRunsService as any,
			dataCoverageService as any,
			{} as any, // metaAudienceGeoStatsRepo
			{} as any, // metaAudienceDemographicStatsRepo
			{} as any, // metaAccountTokensRepo
			{} as any, // metaFacebookPagesRepo
			{} as any, // metaFacebookPostsRepo
			{} as any, // metaFacebookPageInsightsRepo
			{} as any, // metaFacebookVideoMetricsRepo
			{} as any, // metaContentMetricSnapshotsRepo
			{} as any, // metaInstagramProfilesRepo
			{} as any, // metaInstagramMediaRepo
			accountInsightsRepo as any,
			{} as any, // metaInstagramMediaInsightsRepo
			{} as any, // metaVideoGeoStatsRepo
			{} as any, // metaGeoLocationsRepo
			metaIngestionRunsRepo as any,
			{} as any, // metaRateLimitEventsRepo
			{} as any, // countryListRepo
			cityListRepo as any
		);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	describe('extractInstagramGeoEntries', () => {
		const extract = (value: unknown, fallback?: string) =>
			(service as any).extractInstagramGeoEntries(value, fallback);

		it('reads the structured breakdowns shape', () => {
			const entries = extract({
				breakdowns: [
					{
						dimension_keys: ['country'],
						results: [
							{ dimension_values: ['SA'], value: 120 },
							{ dimension_values: ['EG'], value: 80 }
						]
					}
				]
			});

			expect(entries).toEqual([
				{ geoType: 'country', geoKey: 'SA', value: 120 },
				{ geoType: 'country', geoKey: 'EG', value: 80 }
			]);
		});

		it('returns nothing — not the array index "0" — when breakdowns carry no results', () => {
			expect(extract({ breakdowns: [{ dimension_keys: ['country'] }] }, 'country')).toEqual([]);
			expect(extract({ breakdowns: [{ dimension_keys: ['city'], results: [] }] }, 'city')).toEqual([]);
		});

		it('still accepts the legacy flat map shape', () => {
			const entries = extract({ country: { SA: 5, AE: 3 } });

			expect(entries).toEqual([
				{ geoType: 'country', geoKey: 'SA', value: 5 },
				{ geoType: 'country', geoKey: 'AE', value: 3 }
			]);
		});
	});

	describe('facebookPageInsightMetricConfigs', () => {
		it('asks for the live successor metrics, never the retired ones as primaries', () => {
			const configs = (service as any).facebookPageInsightMetricConfigs as Array<{ metricKey: string; candidates: string[] }>;
			const primaries = configs.map((c) => c.candidates[0]);
			expect(primaries).toEqual(expect.arrayContaining([
				'page_follows', 'page_daily_follows_unique', 'page_daily_unfollows_unique',
				'page_views_total', 'page_post_engagements', 'page_video_views',
				'page_video_view_time', 'page_video_complete_views_30s', 'page_actions_post_reactions_total'
			]));
			expect(primaries).not.toEqual(expect.arrayContaining(['page_fans', 'page_impressions', 'page_impressions_unique']));
		});
	});

	describe('fetchInstagramMediaInsightRows', () => {
		const invalidMetric = (metric: string) => ({
			response: { status: 400, data: { error: { code: 100, message: `(#100) The ${metric} metric is not supported for this media type` } } }
		});

		it('requests shares with the core metrics and the reels pair for video', async () => {
			metaApiService.get.mockResolvedValue({ data: [] });
			await (service as any).fetchInstagramMediaInsightRows('m1', 'tok', 'VIDEO');
			expect(metaApiService.get.mock.calls[0][1].params.metric.split(',')).toEqual(
				expect.arrayContaining(['total_interactions', 'reach', 'saved', 'shares', 'views', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'])
			);
		});

		it('drops only the metric Meta names and retries, remembering it per media type', async () => {
			metaApiService.get
				.mockRejectedValueOnce(invalidMetric('ig_reels_avg_watch_time'))
				.mockRejectedValueOnce(invalidMetric('ig_reels_video_view_total_time'))
				.mockResolvedValueOnce({ data: [{ name: 'shares', values: [{ value: 4 }] }] });

			const result = await (service as any).fetchInstagramMediaInsightRows('m1', 'tok', 'VIDEO');

			expect(result.rows).toHaveLength(1);
			const metricsPerCall = metaApiService.get.mock.calls.map((c) => c[1].params.metric.split(','));
			expect(metricsPerCall[1]).not.toContain('ig_reels_avg_watch_time');
			expect(metricsPerCall[2]).not.toContain('ig_reels_video_view_total_time');
			expect(metricsPerCall[2]).toContain('shares');
			// Next media of the same type skips both without a retry.
			metaApiService.get.mockClear();
			metaApiService.get.mockResolvedValueOnce({ data: [] });
			await (service as any).fetchInstagramMediaInsightRows('m2', 'tok', 'VIDEO');
			expect(metaApiService.get).toHaveBeenCalledTimes(1);
			expect(metaApiService.get.mock.calls[0][1].params.metric).not.toContain('ig_reels');
		});

		it('gives up on non-metric errors without retrying', async () => {
			metaApiService.get.mockRejectedValue(graphError('Invalid OAuth access token', 190));
			const result = await (service as any).fetchInstagramMediaInsightRows('m1', 'tok', 'IMAGE');
			expect(result.rows).toEqual([]);
			expect(result.errors[0]).toContain('Invalid OAuth');
			expect(metaApiService.get).toHaveBeenCalledTimes(1);
		});
	});

	describe('ingestInstagramAccountInsights', () => {
		it('labels time-series values by the day that ended at end_time and asks for totals one day at a time', async () => {
			metaApiService.get.mockImplementation(async (_path, options) => {
				if (options.params.metric_type === 'total_value') {
					return { data: [{ name: 'profile_views', total_value: { value: 2405 } }, { name: 'views', total_value: { value: 968743 } }] };
				}
				if (options.params.metric === 'follower_count') {
					return { data: [] };
				}
				return { data: [{ name: 'reach', values: [{ end_time: '2026-09-15T07:00:00+0000', value: 14167 }] }] };
			});

			const result = await (service as any).ingestInstagramAccountInsights('tok', '178', { windowDays: 3 });

			expect(result.days).toHaveLength(3);
			// reach series + follower_count series + 1 total_value call per day
			expect(metaApiService.get).toHaveBeenCalledTimes(5);
			const totalCalls = metaApiService.get.mock.calls.filter((c) => c[1].params.metric_type === 'total_value');
			for (const call of totalCalls) {
				const since = new Date(`${call[1].params.since}T00:00:00Z`);
				const until = new Date(`${call[1].params.until}T00:00:00Z`);
				expect(until.getTime() - since.getTime()).toBe(86_400_000);
			}
			const reachRow = accountInsightsRepo.create.mock.calls.map((c) => c[0]).find((r) => r.metric === 'reach');
			expect(reachRow.date).toBe('2026-09-14');
			expect(reachRow.value).toBe('14167');
			expect(result.upserted).toBe(1 + 3 * 2);
		});

		it('records a warning and coverage gap for a failed day without aborting the rest', async () => {
			let call = 0;
			metaApiService.get.mockImplementation(async (_path, options) => {
				if (options.params.metric_type === 'total_value' && call++ === 0) {
					throw graphError('Temporary failure', 2);
				}
				return { data: [] };
			});

			const result = await (service as any).ingestInstagramAccountInsights('tok', '178', { windowDays: 2 });

			expect(result.warnings).toHaveLength(1);
			// reach + follower_count + 2 days of totals; the failed day does not stop the next
			expect(metaApiService.get).toHaveBeenCalledTimes(4);
			expect(dataCoverageService.recordAttempt).toHaveBeenCalledWith(
				expect.objectContaining({ metricKey: 'instagram.account_insights.daily_totals', success: false })
			);
		});
	});

	describe('resolveCityCoordinates', () => {
		const resolve = (geoKey: string) => (service as any).resolveCityCoordinates(geoKey);
		const cityRow = (over: Partial<Record<string, unknown>> = {}) => ({
			countryCode: 'SY',
			admin1Name: 'Latakia',
			population: 400000,
			latitude: '35.5167',
			longitude: '35.7833',
			...over
		});

		it('matches on the normalised name and returns the country with the coordinates', async () => {
			cityListRepo.findAll.mockResolvedValueOnce([cityRow()]);

			const result = await resolve('Latakia, Latakia Governorate');

			expect(cityListRepo.findAll).toHaveBeenCalledWith(
				expect.objectContaining({ where: { nameKey: 'latakia' } })
			);
			expect(result).toEqual({ latitude: '35.5167', longitude: '35.7833', countryCode: 'SY' });
		});

		it('falls back to alternate spellings when the primary name misses', async () => {
			cityListRepo.findAll
				.mockResolvedValueOnce([]) // primary nameKey lookup
				.mockResolvedValueOnce([cityRow({ admin1Name: 'Latakia' })]); // alternate-name lookup

			const result = await resolve('Lattakia, Latakia Governorate');

			expect(cityListRepo.findAll.mock.calls[1][0].where.alternateNames[Op.like]).toBe('%|lattakia|%');
			expect(result?.countryCode).toBe('SY');
		});

		it('disambiguates same-named cities by matching the region string', async () => {
			cityListRepo.findAll.mockResolvedValueOnce([
				cityRow({ countryCode: 'US', admin1Name: 'Texas', population: 2_300_000 }),
				cityRow({ countryCode: 'EG', admin1Name: 'Cairo Governorate', population: 9_000_000 })
			]);

			const result = await resolve('Cairo, Cairo Governorate');

			// Population-only would have picked the larger (US) city; the region match wins.
			expect(result?.countryCode).toBe('EG');
		});

		it('falls back to the most populous match when no region matches', async () => {
			cityListRepo.findAll.mockResolvedValueOnce([
				cityRow({ countryCode: 'MA', admin1Name: 'Rabat-Salé-Kénitra', population: 590000 }),
				cityRow({ countryCode: 'MA', admin1Name: 'Marrakesh-Safi', population: 130000 })
			]);

			const result = await resolve('Salé, Rabat-Salé-Zemmour-Zaer');

			expect(result?.countryCode).toBe('MA');
		});

		it('records a coverage gap instead of matching a non-city key like "0"', async () => {
			const result = await resolve('0');

			expect(result).toBeNull();
			expect(cityListRepo.findAll).not.toHaveBeenCalled();
		});

		it('reports the gazetteer as unseeded rather than as sixty-one individual misses', async () => {
			cityListRepo.count.mockResolvedValue(0);

			const result = await resolve('Damascus, Damascus Governorate');

			expect(result).toBeNull();
			expect(dataCoverageService.recordAttempt).toHaveBeenCalledWith(
				expect.objectContaining({
					metricKey: 'meta.geo.city_coordinates',
					scope: null,
					reason: expect.stringContaining('CityList is empty')
				})
			);
			expect(cityListRepo.findAll).not.toHaveBeenCalled();
		});

		it('records an unresolved city as a per-city coverage gap, not a global one', async () => {
			cityListRepo.findAll.mockResolvedValue([]);

			const result = await resolve('Nowhereville, Nowhere Province');

			expect(result).toBeNull();
			expect(dataCoverageService.recordAttempt).toHaveBeenCalledWith(
				expect.objectContaining({
					metricKey: 'meta.geo.city_coordinates',
					scope: 'Nowhereville, Nowhere Province'
				})
			);
		});
	});

	describe('fetchInstagramAudienceInsightRows', () => {
		const emptyBreakdown = { data: [{ total_value: { breakdowns: [{ dimension_keys: ['country'], results: [] }] } }] };
		const filledBreakdown = {
			data: [{ total_value: { breakdowns: [{ dimension_keys: ['country'], results: [{ dimension_values: ['SA'], value: 40 }] }] } }]
		};

		it('moves to the next timeframe when Meta returns the shape but no entries', async () => {
			metaApiService.get.mockImplementation(async (_path, options) =>
				options.params.timeframe === 'this_month' ? emptyBreakdown : filledBreakdown
			);

			const result = await (service as any).fetchInstagramAudienceInsightRows(
				'token', '178', 'engaged_audience_demographics', 'country', ['this_month', 'last_30_days', 'prev_month']
			);

			expect(result.timeframe).toBe('last_30_days');
			const tried = metaApiService.get.mock.calls.map((call) => call[1].params.timeframe);
			expect(tried).toEqual(['this_month', 'last_30_days']);
		});

		it('returns the last empty answer, not an error, when every timeframe is empty', async () => {
			metaApiService.get.mockResolvedValue(emptyBreakdown);

			const result = await (service as any).fetchInstagramAudienceInsightRows(
				'token', '178', 'engaged_audience_demographics', 'country', ['this_month', 'last_30_days']
			);

			expect(result.timeframe).toBe('last_30_days');
			expect(result.rows).toHaveLength(1);
		});

		it('keeps the first timeframe when it already has data', async () => {
			metaApiService.get.mockResolvedValue(filledBreakdown);

			const result = await (service as any).fetchInstagramAudienceInsightRows(
				'token', '178', 'engaged_audience_demographics', 'country', ['this_month', 'last_30_days']
			);

			expect(result.timeframe).toBe('this_month');
			expect(metaApiService.get).toHaveBeenCalledTimes(1);
		});
	});

	describe('fetchFacebookPostRows', () => {
		const range = { startDate: '2026-08-16', endDate: '2026-09-15' };

		it('steps the page size down when Graph says the request is too much data', async () => {
			metaApiService.get.mockImplementation(async (_path, options) => {
				if (options.params.limit === 100) {
					throw graphError(REDUCE_DATA_MESSAGE);
				}
				return { data: [{ id: 'post-1' }, { id: 'post-2' }], paging: {} };
			});

			const rows = await (service as any).fetchFacebookPostRows('token', '153', range);

			expect(rows.map((row: any) => row.id)).toEqual(['post-1', 'post-2']);
			const limitsTried = metaApiService.get.mock.calls.map((call) => call[1].params.limit);
			expect(limitsTried).toEqual([100, 25]);
		});

		it('gives up after the smallest page size and surfaces the error', async () => {
			metaApiService.get.mockRejectedValue(graphError(REDUCE_DATA_MESSAGE));

			await expect(
				(service as any).fetchFacebookPostRows('token', '153', range)
			).rejects.toMatchObject({ response: { data: { error: { message: REDUCE_DATA_MESSAGE } } } });

			const limitsTried = metaApiService.get.mock.calls.map((call) => call[1].params.limit);
			expect(limitsTried).toEqual([100, 25, 10]);
		});

		it('does not retry other errors with a smaller page', async () => {
			metaApiService.get.mockRejectedValue(graphError('Invalid OAuth access token', 190));

			await expect(
				(service as any).fetchFacebookPostRows('token', '153', range)
			).rejects.toBeDefined();
			expect(metaApiService.get).toHaveBeenCalledTimes(1);
		});
	});

	describe('fetchFacebookPagePostCount', () => {
		const idsPage = (start: number, count: number, after: string | null) => ({
			data: Array.from({ length: count }, (_, index) => ({ id: `post-${start + index}` })),
			paging: after ? { cursors: { after } } : {}
		});

		it('returns the exact count for a page inside the walk cap', async () => {
			metaApiService.get
				.mockResolvedValueOnce(idsPage(0, 100, 'cursor-1'))
				.mockResolvedValueOnce(idsPage(100, 50, null));

			const count = await (service as any).fetchFacebookPagePostCount('token', '153');

			expect(count).toBe(150);
			expect(dataCoverageService.recordAttempt).toHaveBeenCalledWith(
				expect.objectContaining({ metricKey: 'facebook.page.post_count', success: true })
			);
		});

		it('stops walking at the cap and reports the count as unobtainable', async () => {
			let page = 0;
			metaApiService.get.mockImplementation(async () => idsPage(page++ * 100, 100, `cursor-${page}`));

			const count = await (service as any).fetchFacebookPagePostCount('token', '153');

			expect(count).toBeNull();
			// 2000-post cap → 20 full pages plus the one probe row on a 21st page.
			expect(metaApiService.get).toHaveBeenCalledTimes(21);
			expect(dataCoverageService.recordAttempt).toHaveBeenCalledWith(
				expect.objectContaining({
					metricKey: 'facebook.page.post_count',
					success: false,
					status: 'unavailable_unsupported'
				})
			);
		});
	});

	describe('ingestContentSnapshot', () => {
		const stubSources = (facebook: () => Promise<any>, instagram: () => Promise<any>) => {
			jest.spyOn(service as any, 'resolveInstagramAccountId').mockResolvedValue('17841400714806415');
			jest.spyOn(service as any, 'ingestFacebookPosts').mockImplementation(facebook);
			jest.spyOn(service as any, 'ingestInstagramMedia').mockImplementation(instagram);
		};
		const emptyResult = () =>
			Promise.resolve({ created: 0, updated: 0, processed: 0, total: 0, tierSummary: createEmptyTierSummary() });

		it('fails the run when every source was skipped, instead of reporting success', async () => {
			stubSources(
				() => Promise.reject(graphError(REDUCE_DATA_MESSAGE)),
				() => Promise.reject(new Error('Meta API paused for instagram_media_content_snapshot until 2026-09-15T06:42:35.754Z (rate_limit)'))
			);

			await expect(service.ingestContentSnapshot()).rejects.toBeInstanceOf(BadGatewayException);

			expect(ingestionRunsService.completeRun).not.toHaveBeenCalled();
			expect(ingestionRunsService.failRun).toHaveBeenCalledWith(
				99,
				expect.objectContaining({
					message: expect.stringContaining('every source was skipped')
				}),
				expect.anything()
			);
		});

		it('still completes when one source is skipped but the other ingested', async () => {
			stubSources(() => Promise.reject(graphError(REDUCE_DATA_MESSAGE)), emptyResult);

			const result = await service.ingestContentSnapshot();

			expect(result.data.warnings).toHaveLength(1);
			expect(ingestionRunsService.completeRun).toHaveBeenCalledWith(
				99,
				expect.objectContaining({ metadata: expect.objectContaining({ warnings: result.data.warnings }) })
			);
			expect(ingestionRunsService.failRun).not.toHaveBeenCalled();
		});
	});
});
