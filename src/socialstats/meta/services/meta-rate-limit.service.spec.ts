import { Logger } from '@nestjs/common';
import { MetaRateLimitPauseError, MetaRateLimitService } from './meta-rate-limit.service';

describe('MetaRateLimitService shared cooldowns', () => {
	let service: MetaRateLimitService;
	let repo: { findAll: jest.Mock; create: jest.Mock };

	beforeEach(() => {
		jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
		repo = {
			findAll: jest.fn().mockResolvedValue([]),
			create: jest.fn().mockResolvedValue(undefined)
		};
		service = new MetaRateLimitService(repo as any);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('pauses on a rate-limit event another instance persisted 20s ago with a 60s window', async () => {
		repo.findAll.mockResolvedValue([
			{
				endpoint: 'instagram_profile_snapshot',
				retryAfterSeconds: 60,
				occurredAt: new Date(Date.now() - 20_000),
				rawJson: '{}'
			}
		]);

		await expect(service.assertRequestAllowed('page_profile_snapshot')).rejects.toBeInstanceOf(
			MetaRateLimitPauseError
		);
		const status = await service.getStatus();
		const global = status.data.activeCooldowns.find((entry) => entry.endpoint === '__global__');
		expect(global?.active).toBe(true);
		expect(global?.reason).toBe('rate_limit');
	});

	it('ignores events whose retry window has already closed', async () => {
		repo.findAll.mockResolvedValue([
			{
				endpoint: 'instagram_profile_snapshot',
				retryAfterSeconds: 60,
				occurredAt: new Date(Date.now() - 120_000),
				rawJson: '{}'
			}
		]);

		await expect(service.assertRequestAllowed('page_profile_snapshot')).resolves.toBeUndefined();
	});

	it('marks a shared usage-threshold pause so observeUsage does not stack another on top', async () => {
		repo.findAll.mockResolvedValue([
			{
				endpoint: 'facebook_posts_content_snapshot_posts',
				retryAfterSeconds: 900,
				occurredAt: new Date(Date.now() - 60_000),
				rawJson: JSON.stringify({ type: 'usage_threshold_pause', maxObservedUsage: 95 })
			}
		]);

		await expect(service.assertRequestAllowed('page_profile_snapshot')).rejects.toBeInstanceOf(
			MetaRateLimitPauseError
		);
		await service.observeUsage({
			source: 'tokenized_get',
			endpoint: 'page_profile_snapshot',
			appUsage: JSON.stringify({ call_count: 96 })
		});
		expect(repo.create).not.toHaveBeenCalled();
	});

	it('reads the shared table at most once per interval when nothing is paused', async () => {
		await service.assertRequestAllowed('a');
		await service.assertRequestAllowed('b');
		await service.assertRequestAllowed('c');

		expect(repo.findAll).toHaveBeenCalledTimes(1);
	});

	it('never lets a DB failure block a Meta call', async () => {
		repo.findAll.mockRejectedValue(new Error('db down'));

		await expect(service.assertRequestAllowed('page_profile_snapshot')).resolves.toBeUndefined();
	});
});
