import { IngestionStatusService } from './ingestion-status.service';

describe('IngestionStatusService', () => {
	let service: IngestionStatusService;
	let ingestionRunsRepo: { findOne: jest.Mock; findAll: jest.Mock };

	beforeEach(() => {
		ingestionRunsRepo = {
			findOne: jest.fn().mockResolvedValue(null),
			findAll: jest.fn().mockResolvedValue([])
		};
		service = new IngestionStatusService(
			ingestionRunsRepo as any,
			{} as any, // metaFacebookPostsRepo
			{} as any, // metaInstagramMediaRepo
			{} as any, // youtubeLiveViewerStatsRepo
			{} as any, // youtubeVideoGeoStatsRepo
			{ findAll: jest.fn().mockResolvedValue([]) } as any, // metaAccountTokensRepo
			{} as any, // dataCoverageService
			{} as any // ingestionControlService
		);
	});

	const freshRow = (platform: string, jobType: string, lastSuccessfulRunAt: string | null) => ({
		platform,
		jobType,
		entityType: 'page',
		lastSuccessfulRunAt,
		status: lastSuccessfulRunAt ? 'fresh' : 'missing'
	});

	const failure = (platform: string, jobType: string, finishedAt: string) => ({
		platform,
		jobType,
		status: 'failed',
		finishedAt
	});

	describe('buildPlatformSummary', () => {
		it('ignores a failure that a later success of the same job has superseded', () => {
			const summary = (service as any).buildPlatformSummary(
				[freshRow('meta', 'profile_snapshot', '2026-09-15T05:41:02.435Z')],
				[failure('meta', 'profile_snapshot', '2026-09-14T00:11:10.566Z')]
			);

			expect(summary.meta.status).toBe('fresh');
		});

		it('still degrades on a failure newer than the last success', () => {
			const summary = (service as any).buildPlatformSummary(
				[freshRow('meta', 'profile_snapshot', '2026-09-14T05:41:02.435Z')],
				[failure('meta', 'profile_snapshot', '2026-09-15T00:11:10.566Z')]
			);

			expect(summary.meta.status).toBe('degraded');
		});

		it('degrades on a failure for a job that has never succeeded', () => {
			const summary = (service as any).buildPlatformSummary(
				[freshRow('meta', 'profile_snapshot', '2026-09-15T05:41:02.435Z')],
				[failure('meta', 'analytics_snapshot', '2026-09-14T00:11:10.566Z')]
			);

			expect(summary.meta.status).toBe('degraded');
		});

		it('never lets another platform’s failure leak into this one', () => {
			const summary = (service as any).buildPlatformSummary(
				[freshRow('meta', 'profile_snapshot', '2026-09-15T05:41:02.435Z')],
				[failure('youtube', 'live_viewers', '2026-09-15T07:30:00.003Z')]
			);

			expect(summary.meta.status).toBe('fresh');
		});
	});

	describe('buildRecentFailures', () => {
		it('queries each tracked platform separately so a noisy job cannot crowd the others out', async () => {
			ingestionRunsRepo.findAll.mockImplementation(async ({ where }: any) =>
				where.platform === 'youtube'
					? Array.from({ length: 10 }, (_, i) => failure('youtube', 'live_viewers', `2026-09-15T12:${String(59 - i).padStart(2, '0')}:00Z`))
					: where.platform === 'meta'
						? [failure('meta', 'profile_snapshot', '2026-09-14T00:11:10Z')]
						: []
			);

			const failures = await (service as any).buildRecentFailures();

			const platforms = ingestionRunsRepo.findAll.mock.calls.map((call) => call[0].where.platform);
			expect(platforms).toEqual(['meta', 'youtube', 'linkedin', 'tiktok']);
			expect(failures.some((row: any) => row.platform === 'meta')).toBe(true);
			expect(failures[0].platform).toBe('youtube'); // still newest-first across platforms
		});
	});

	describe('buildFreshness with expectsRecords', () => {
		const completed = (finishedAt: string, recordsUpserted: number) => ({
			status: 'completed',
			finishedAt,
			recordsUpserted,
			entityId: 'UCsHdPPJXT-yKVTLGkn3DSvQ'
		});

		it('treats a run that completed without writing rows as not a success', async () => {
			// Latest completed run wrote nothing (last night); the last one that did was two
			// months ago — exactly the frozen geo_device case.
			ingestionRunsRepo.findOne.mockImplementation(async ({ where }: any) =>
				where.recordsUpserted
					? completed('2026-07-14T00:45:00Z', 120)
					: completed('2026-09-15T00:45:05Z', 0)
			);

			const rows = await (service as any).buildFreshness('youtube');
			const geoDevice = rows.find((row: any) => row.jobType === 'geo_device');

			expect(geoDevice.expectsRecords).toBe(true);
			expect(geoDevice.lastCompletedRunAt).toBe('2026-09-15T00:45:05Z');
			expect(geoDevice.lastSuccessfulRunAt).toBe('2026-07-14T00:45:00Z');
			expect(geoDevice.status).toBe('stale');
		});

		it('does not apply the rule to jobs that may legitimately write nothing', async () => {
			ingestionRunsRepo.findOne.mockResolvedValue(completed(new Date().toISOString(), 0));

			const rows = await (service as any).buildFreshness('youtube');
			const liveViewers = rows.find((row: any) => row.jobType === 'live_viewers');

			expect(liveViewers.expectsRecords).toBe(false);
			expect(liveViewers.status).toBe('fresh');
			// Only one query per job here: no second "with rows" lookup.
			const liveViewerQueries = ingestionRunsRepo.findOne.mock.calls.filter(
				(call) => call[0].where.jobType === 'live_viewers'
			);
			expect(liveViewerQueries).toHaveLength(1);
		});
	});

	describe('buildCredentialStatus', () => {
		it('flags a Meta token that lapses within 14 days', async () => {
			const in10Days = new Date(Date.now() + 10 * 86_400_000 - 60_000);
			(service as any).metaAccountTokensRepo.findAll.mockResolvedValue([
				{ accountType: 'user', expiresAt: in10Days, isExpired: false, refreshStatus: 'active' },
				{ accountType: 'page', expiresAt: null, isExpired: false, refreshStatus: 'active' }
			]);

			const credentials = await (service as any).buildCredentialStatus();

			expect(credentials.meta.status).toBe('expiring_soon');
			expect(credentials.meta.tokens.find((t: any) => t.accountType === 'user').daysRemaining).toBe(9);
			expect(credentials.meta.tokens.find((t: any) => t.accountType === 'page').status).toBe('ok');
		});
	});
});
