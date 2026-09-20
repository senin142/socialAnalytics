import { MetaDashboardService } from './meta-dashboard.service';

describe('MetaDashboardService', () => {
	let service: MetaDashboardService;
	let metaFacebookPagesRepo: { findAll: jest.Mock };
	let metaFacebookPostsRepo: { findAll: jest.Mock; findOne: jest.Mock };
	let metaInstagramProfilesRepo: { findAll: jest.Mock; findOne?: jest.Mock };
	let metaInstagramMediaRepo: { findAll: jest.Mock; findOne: jest.Mock };
	let metaAudienceGeoStatsRepo: { findAll: jest.Mock };
	let metaFacebookPageInsightsRepo: { findAll: jest.Mock };
	let metaVideoGeoStatsRepo: { findAll: jest.Mock };
	let metaGeoLocationsRepo: { findAll: jest.Mock };
	let metaContentMetricSnapshotsRepo: { findAll: jest.Mock };

	beforeEach(() => {
		metaFacebookPagesRepo = {
			findAll: jest.fn().mockResolvedValue([])
		};
		metaFacebookPostsRepo = {
			findAll: jest.fn().mockResolvedValue([]),
			findOne: jest.fn().mockResolvedValue(null)
		};
		metaInstagramProfilesRepo = {
			findAll: jest.fn().mockResolvedValue([])
		};
		metaInstagramMediaRepo = {
			findAll: jest.fn().mockResolvedValue([]),
			findOne: jest.fn().mockResolvedValue(null)
		};
		metaAudienceGeoStatsRepo = {
			findAll: jest.fn().mockResolvedValue([])
		};
		metaFacebookPageInsightsRepo = {
			findAll: jest.fn().mockResolvedValue([])
		};
		metaVideoGeoStatsRepo = {
			findAll: jest.fn().mockResolvedValue([])
		};
		metaGeoLocationsRepo = {
			findAll: jest.fn().mockResolvedValue([])
		};
		metaContentMetricSnapshotsRepo = {
			findAll: jest.fn().mockResolvedValue([])
		};

		service = new MetaDashboardService(
			{ getEffectivePageToken: jest.fn() } as any,
			{ get: jest.fn() } as any,
			metaFacebookPagesRepo as any,
			metaFacebookPostsRepo as any,
			metaContentMetricSnapshotsRepo as any,
			metaInstagramProfilesRepo as any,
			metaInstagramMediaRepo as any,
			metaAudienceGeoStatsRepo as any,
			metaFacebookPageInsightsRepo as any,
			metaVideoGeoStatsRepo as any,
			metaGeoLocationsRepo as any
		);
	});

	it('uses date-filtered Facebook post rows for the overview post count', async () => {
		metaFacebookPagesRepo.findAll.mockResolvedValue([
			{ pageId: '153145408089596', followers: '3930631', fans: '3930631', postCount: '0' }
		]);
		metaFacebookPostsRepo.findAll.mockResolvedValue([
			{
				postId: 'fb-1',
				pageId: '153145408089596',
				message: 'First',
				createdTime: '2026-09-10T00:00:00.000Z',
				likes: '1',
				comments: '0',
				shares: '0'
			},
			{
				postId: 'fb-2',
				pageId: '153145408089596',
				message: 'Second',
				createdTime: '2026-09-11T00:00:00.000Z',
				likes: '2',
				comments: '0',
				shares: '0'
			}
		]);

		const result = await service.getDashboardOverview('2026-09-03', '2026-09-18', 'facebook');

		expect(result.data.totals.contentCount).toBe(2);
		expect(result.data.profiles.facebookPostCount).toBe(2);
	});

	it('keeps stored Facebook engagement even when legacy rows are missing engagementSource', async () => {
		metaFacebookPagesRepo.findAll.mockResolvedValue([
			{ pageId: '153145408089596', followers: '3930631', fans: '3930631', postCount: '0' }
		]);
		metaFacebookPostsRepo.findAll.mockResolvedValue([
			{
				postId: 'fb-legacy',
				pageId: '153145408089596',
				message: 'Legacy engagement row',
				createdTime: '2026-09-10T00:00:00.000Z',
				likes: '5',
				comments: '3',
				shares: '2',
				reach: '100',
				impressions: '200',
				engagement: '15',
				engagementSource: null
			}
		]);

		const result = await service.getDashboardOverview('2026-09-03', '2026-09-18', 'facebook');

		expect(result.data.totals.engagement).toBe(15);
		expect(result.data.series[0].engagement).toBe(15);
	});

	it('falls back to the latest available audience geo snapshot when the requested range has no rows', async () => {
		metaAudienceGeoStatsRepo.findAll
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{
					platform: 'facebook',
					startDate: '2026-09-01',
					endDate: '2026-09-16',
					fetchedAt: '2026-09-16T12:00:00.000Z'
				}
			])
			.mockResolvedValueOnce([
				{
					platform: 'facebook',
					assetId: '153145408089596',
					geoType: 'country',
					geoKey: 'AE',
					geoName: 'United Arab Emirates',
					metric: 'followers',
					value: '120',
					startDate: '2026-09-01',
					endDate: '2026-09-16'
				},
				{
					platform: 'facebook',
					assetId: '153145408089596',
					geoType: 'country',
					geoKey: 'AE',
					geoName: 'United Arab Emirates',
					metric: 'engaged_audience',
					value: '40',
					startDate: '2026-09-01',
					endDate: '2026-09-16'
				}
			]);

		const result = await service.getGeoBreakdown(
			'2026-09-03',
			'2026-09-18',
			'facebook',
			'country',
			'followers'
		);

		expect(metaAudienceGeoStatsRepo.findAll).toHaveBeenCalledTimes(3);
		expect(result.data).toHaveLength(1);
		expect(result.data[0]).toMatchObject({
			geoKey: 'AE',
			followers: 120,
			engagedAudience: 40,
			value: 120
		});
	});

	it('falls back to Facebook page insights geo when audience geo rows are absent', async () => {
		metaAudienceGeoStatsRepo.findAll.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
		metaFacebookPageInsightsRepo.findAll.mockResolvedValue([
			{
				pageId: '153145408089596',
				metric: 'page_fans_country',
				value: JSON.stringify({
					AE: 300,
					SA: 120
				})
			}
		]);

		const result = await service.getGeoBreakdown(
			'2026-09-03',
			'2026-09-18',
			'facebook',
			'country',
			'followers'
		);

		expect(metaFacebookPageInsightsRepo.findAll).toHaveBeenCalledTimes(1);
		expect(result.data).toHaveLength(2);
		expect(result.data[0]).toMatchObject({
			geoKey: 'AE',
			followers: 300,
			value: 300
		});
	});
});
