import { Logger } from '@nestjs/common';
import { MetaApiService } from './meta-api.service';

describe('MetaApiService', () => {
	let service: MetaApiService;
	let metaRateLimitService: {
		assertRequestAllowed: jest.Mock;
		observeUsage: jest.Mock;
		recordRateLimitEvent: jest.Mock;
	};
	let loggerErrorSpy: jest.SpyInstance;

	beforeEach(() => {
		metaRateLimitService = {
			assertRequestAllowed: jest.fn(),
			observeUsage: jest.fn(),
			recordRateLimitEvent: jest.fn()
		};
		service = new MetaApiService(metaRateLimitService as any);
		loggerErrorSpy = jest
			.spyOn(Logger.prototype, 'error')
			.mockImplementation(() => undefined);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('logs non-rate-limit Meta errors without persisting a rate-limit event', async () => {
		(service as any).client.get = jest.fn().mockRejectedValue({
			message: 'Request failed with status code 400',
			response: {
				status: 400,
				data: {
					error: {
						message:
							'Error validating access token: Session has expired on Thursday, August 6, 2026.',
						type: 'OAuthException',
						code: 190,
						error_subcode: 463
					}
				},
				headers: {}
			}
		});

		await expect(
			service.get('/me', {
				accessToken: 'expired-token',
				endpointLabel: 'page_profile_snapshot'
			})
		).rejects.toMatchObject({
			response: {
				data: {
					error: {
						code: 190
					}
				}
			}
		});

			expect(metaRateLimitService.recordRateLimitEvent).not.toHaveBeenCalled();
			expect(metaRateLimitService.assertRequestAllowed).toHaveBeenCalledWith(
				'page_profile_snapshot'
			);
			expect(loggerErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'Meta API request failed for page_profile_snapshot [tokenized_get] status=400 code=190 subcode=463 OAuthException'
			)
		);
	});

	it('does not treat "reduce the amount of data" as a rate limit', async () => {
		(service as any).client.get = jest.fn().mockRejectedValue({
			message: 'Request failed with status code 500',
			response: {
				status: 500,
				data: {
					error: {
						message: "Please reduce the amount of data you're asking for, then retry your request",
						type: 'OAuthException',
						code: 1
					}
				},
				headers: {}
			}
		});

		await expect(
			service.get('/153/posts', {
				accessToken: 'valid-token',
				endpointLabel: 'facebook_posts_content_snapshot_posts'
			})
		).rejects.toMatchObject({ response: { data: { error: { code: 1 } } } });

		// A too-heavy request must not arm the global cooldown that would block the
		// caller's own smaller retry and every unrelated endpoint behind it.
		expect(metaRateLimitService.recordRateLimitEvent).not.toHaveBeenCalled();
	});

	it('records actual rate-limit responses', async () => {
		(service as any).client.get = jest.fn().mockRejectedValue({
			message: 'Request failed with status code 429',
			response: {
				status: 429,
				data: {
					error: {
						message: 'Application request limit reached',
						type: 'OAuthException',
						code: 4,
						error_subcode: 2446079,
						is_transient: true
					}
				},
				headers: {
					'retry-after': '120',
					'x-app-usage': { call_count: 100 }
				}
			}
		});

		await expect(
			service.get('/me', {
				accessToken: 'valid-token',
				endpointLabel: 'page_profile_snapshot'
			})
		).rejects.toMatchObject({
			response: {
				status: 429
			}
		});

			expect(metaRateLimitService.recordRateLimitEvent).toHaveBeenCalledWith({
				source: 'tokenized_get',
				endpoint: 'page_profile_snapshot',
			errorCode: 4,
			errorSubcode: 2446079,
			isTransient: true,
			retryAfterSeconds: 120,
			appUsage: JSON.stringify({ call_count: 100 }),
			pageUsage: null,
				rawJson: JSON.stringify({
					responseData: {
						error: {
							message: 'Application request limit reached',
							type: 'OAuthException',
							code: 4,
							error_subcode: 2446079,
							is_transient: true
						}
					},
					businessUsage: null
				})
			});
		});

		it('observes usage headers on successful requests', async () => {
			(service as any).client.get = jest.fn().mockResolvedValue({
				data: { ok: true },
				headers: {
					'x-app-usage': { call_count: 91 },
					'x-page-usage': { call_count: 10 },
					'x-business-use-case-usage': { ads_management: [{ call_count: 20 }] }
				}
			});

			await expect(
				service.get('/me', {
					accessToken: 'valid-token',
					endpointLabel: 'page_profile_snapshot'
				})
			).resolves.toEqual({ ok: true });

			expect(metaRateLimitService.assertRequestAllowed).toHaveBeenCalledWith(
				'page_profile_snapshot'
			);
			expect(metaRateLimitService.observeUsage).toHaveBeenCalledWith({
				source: 'tokenized_get',
				endpoint: 'page_profile_snapshot',
				appUsage: JSON.stringify({ call_count: 91 }),
				pageUsage: JSON.stringify({ call_count: 10 }),
				businessUsage: JSON.stringify({
					ads_management: [{ call_count: 20 }]
				})
			});
		});
	});
