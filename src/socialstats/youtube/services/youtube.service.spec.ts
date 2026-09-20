import { BadGatewayException, Logger } from '@nestjs/common';
import { YoutubeService } from './youtube.service';

jest.mock('../../../common/logger', () => ({
	logToErrorFile: jest.fn()
}));

/**
 * YoutubeService has a wide constructor; these tests exercise the analytics report methods
 * added for content-type / live-vs-VOD / viewer segments / monetization, so only the
 * collaborators those touch are stubbed on a prototype-built instance.
 */
describe('YoutubeService analytics reports', () => {
	let service: YoutubeService;
	let timedGet: jest.Mock;
	let recordAttempt: jest.Mock;

	beforeEach(() => {
		jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
		jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
		timedGet = jest.fn();
		recordAttempt = jest.fn().mockResolvedValue(undefined);
		const cache = new Map<string, any>();
		service = Object.create(YoutubeService.prototype);
		Object.assign(service as any, {
			logger: new Logger('test'),
			youtubeAuthService: { getAccessToken: jest.fn().mockResolvedValue({ accessToken: 'tok', tokenType: 'Bearer', expiresInSeconds: 3600, expiresAt: '2026-09-16T12:00:00Z' }) },
			youtubeQuotaService: { isQuotaExceededError: () => false },
			dataCoverageService: { recordAttempt },
			youtubeAnalyticsSnapshotsRepo: { findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(undefined) },
			timedGet,
			getFromCache: (key: string) => cache.get(key) ?? null,
			setCache: (key: string, value: unknown) => cache.set(key, value)
		});
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	const report = (columns: string[], rows: unknown[][]) => ({
		data: { columnHeaders: columns.map((name) => ({ name })), rows }
	});

	it('getMonetization sums the range and reports a blended CPM, not an average of daily CPMs', async () => {
		timedGet.mockResolvedValue(
			report(['day', 'estimatedRevenue', 'estimatedAdRevenue', 'monetizedPlaybacks', 'adImpressions', 'cpm', 'playbackBasedCpm'], [
				['2026-09-10', 11.069, 9.778, 4508, 6158, 2.887, 3.943],
				['2026-09-11', 7.859, 6.445, 3340, 4414, 2.655, 3.509]
			])
		);

		const result = await service.getMonetization('2026-09-10', '2026-09-11');

		expect(timedGet.mock.calls[0][2].params).toEqual(
			expect.objectContaining({ dimensions: 'day', metrics: expect.stringContaining('estimatedRevenue') })
		);
		expect(result.totals.estimatedRevenue).toBeCloseTo(18.928, 3);
		expect(result.totals.adImpressions).toBe(10572);
		// (9.778 + 6.445) / 10572 * 1000 = 1.5345 → 1.535; a mean of the daily CPMs would be 2.771
		expect(result.totals.cpm).toBe(1.535);
		expect(result.totals.currency).toBe('USD');
	});

	it('getViewerSegments returns the segments that worked and lists the ones that did not', async () => {
		timedGet.mockImplementation(async (_label, _url, config) => {
			if (config.params.dimensions === 'insightPlaybackLocationType') {
				throw { response: { status: 400, data: { error: { message: 'The query is not supported.' } } } };
			}
			return report([config.params.dimensions, 'views', 'estimatedMinutesWatched'], [['A', 10, 5]]);
		});

		const result = await service.getViewerSegments('2026-09-01', '2026-09-13');

		expect(Object.keys(result.data)).toEqual(['subscribedStatus', 'youtubeProduct']);
		expect(result.failed).toEqual([{ segment: 'playbackLocation', reason: expect.stringContaining('The query is not supported.') }]);
		expect(recordAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ metricKey: 'youtube.analytics.viewer_segments.playbackLocation', success: false })
		);
	});

	it('getViewerSegments fails only when every segment fails', async () => {
		timedGet.mockRejectedValue({ response: { status: 500, data: { error: { message: 'boom' } } } });

		await expect(service.getViewerSegments('2026-09-01', '2026-09-13')).rejects.toBeInstanceOf(BadGatewayException);
	});

	it('getContentTypeBreakdown and getLiveVsOnDemand ask for the confirmed dimensions', async () => {
		timedGet.mockResolvedValue(report(['x', 'views'], []));

		await service.getContentTypeBreakdown('2026-09-01', '2026-09-13');
		await service.getLiveVsOnDemand('2026-09-01', '2026-09-13');

		expect(timedGet.mock.calls[0][2].params.dimensions).toBe('creatorContentType');
		expect(timedGet.mock.calls[1][2].params.dimensions).toBe('liveOrOnDemand');
	});

	it('keeps the first six timeseries columns in their original order for the positional UI parser', async () => {
		timedGet.mockResolvedValue(report(['day'], []));
		Object.assign(service as any, {
			applyPaginationToRowsResponse: (result: unknown) => result,
			getAnalyticsScopeHint: () => ''
		});

		await service.getAnalyticsTimeseries('2026-09-01', '2026-09-13');

		const metrics = String(timedGet.mock.calls[0][2].params.metrics).split(',');
		expect(metrics.slice(0, 5)).toEqual([
			'views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost'
		]);
		expect(metrics).toEqual(expect.arrayContaining(['shares', 'dislikes', 'averageViewPercentage', 'engagedViews', 'videosAddedToPlaylists']));
	});
});
