import { Logger } from '@nestjs/common';
import { YoutubeQuotaExceededError, YoutubeQuotaService } from './youtube-quota.service';

describe('YoutubeQuotaService cross-instance usage', () => {
	let service: YoutubeQuotaService;
	let repo: { findAll: jest.Mock; findOne: jest.Mock; create: jest.Mock };
	let dbUnitsUsed: number;

	beforeEach(() => {
		jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
		jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		dbUnitsUsed = 0;
		repo = {
			// The shared table is the sum of every instance's increments.
			findAll: jest.fn(async () => [{ unitsUsed: dbUnitsUsed }]),
			findOne: jest.fn().mockResolvedValue(null),
			create: jest.fn().mockResolvedValue(undefined)
		};
		process.env.YOUTUBE_QUOTA_RESYNC_INTERVAL_MS = '1000';
		service = new YoutubeQuotaService(repo as any);
	});

	afterEach(() => {
		delete process.env.YOUTUBE_QUOTA_RESYNC_INTERVAL_MS;
		jest.restoreAllMocks();
	});

	it('serves the budget check from memory inside the resync interval', async () => {
		await service.assertBudgetAvailable('youtube.videos.list');
		await service.assertBudgetAvailable('youtube.videos.list');
		await service.assertBudgetAvailable('youtube.videos.list');

		expect(repo.findAll).toHaveBeenCalledTimes(1);
	});

	it('sees another instance’s spend once the interval has elapsed', async () => {
		let now = new Date('2026-09-16T10:00:00Z').getTime();
		jest.spyOn(Date, 'now').mockImplementation(() => now);
		await service.assertBudgetAvailable('youtube.videos.list');
		expect(await service.getRemainingBudget('youtube_data_v3')).toBe(10000);

		// Another instance burns almost everything; our memory still says 0 used...
		dbUnitsUsed = 9500;
		expect(await service.getRemainingBudget('youtube_data_v3')).toBe(10000);

		// ...until the next resync, after which the shared total governs the check.
		now += 1500;
		expect(await service.getRemainingBudget('youtube_data_v3')).toBe(500);
		await expect(service.assertBudgetAvailable('youtube.videos.list')).rejects.toBeInstanceOf(
			YoutubeQuotaExceededError
		);
	});

	it('keeps counting locally between resyncs', async () => {
		await service.recordUsage('youtube.videos.list');
		await service.recordUsage('youtube.videos.list');

		expect(await service.getRemainingBudget('youtube_data_v3')).toBe(9998);
		expect(repo.findAll).toHaveBeenCalledTimes(1);
	});
});
