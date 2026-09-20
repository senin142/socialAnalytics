import { MetaAccountTokens } from '../../../database/entity';
import {
	BadGatewayException,
	BadRequestException,
	Inject,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { MetaApiService } from './meta-api.service';

type MetaTokenRow = {
	platformScope: string;
	accountType: string;
	metaAppId: string | null;
	userId: string | null;
	pageId: string | null;
	instagramBusinessAccountId: string | null;
	accessToken: string;
	tokenType: string | null;
	scopes: string | null;
	expiresAt: Date | null;
	lastRefreshedAt: Date | null;
	lastValidatedAt: Date | null;
	isExpired: boolean;
	refreshStatus: string | null;
	lastError: string | null;
};

@Injectable()
export class MetaAuthService {
	constructor(
		private readonly metaApiService: MetaApiService,
		@Inject('META_ACCOUNT_TOKENS_REPOSITORY')
		private readonly metaAccountTokensRepo: typeof MetaAccountTokens
	) { }

	getConfigurationStatus() {
		const systemUserTokenConfigured = Boolean(process.env.META_SYSTEM_USER_TOKEN);
		const legacyAccessTokenConfigured = Boolean(process.env.META_ACCESS_TOKEN);

		return {
			statusCode: 200,
			message: 'Meta auth configuration status fetched successfully',
			data: {
				accessTokenConfigured: legacyAccessTokenConfigured,
				systemUserTokenConfigured,
				appIdConfigured: Boolean(process.env.META_APP_ID),
				appSecretConfigured: Boolean(process.env.META_APP_SECRET),
				redirectUriConfigured: Boolean(process.env.META_REDIRECT_URI),
				pageIdConfigured: Boolean(process.env.META_PAGE_ID),
				instagramAccountConfigured: Boolean(process.env.META_INSTAGRAM_ACCOUNT_ID),
				defaultPageId: process.env.META_PAGE_ID || null,
				defaultInstagramAccountId: process.env.META_INSTAGRAM_ACCOUNT_ID || null,
				defaultApiVersion: process.env.META_GRAPH_API_VERSION || 'v26.0',
				bootstrapMode: systemUserTokenConfigured ? 'system_user' : 'legacy_user_token'
			}
		};
	}

	/** Lightweight live check: confirms the configured credentials actually authenticate
	 * against the Meta Graph API right now (one minimal page-fields call), without touching
	 * ingestion/data-coverage tracking — this exists purely to answer "do these credentials
	 * work". */
	async verifyCredentials(pageId?: string) {
		const checkedAt = new Date().toISOString();
		const config = this.getConfigurationStatus().data;
		if (!config.appIdConfigured || !config.appSecretConfigured) {
			return {
				valid: false,
				reason: 'META_APP_ID/META_APP_SECRET not configured',
				checkedAt
			};
		}

		try {
			const pageTokenRow = await this.getEffectivePageToken(pageId);
			const response = await this.metaApiService.get<{ id: string; name?: string }>(
				`/${pageTokenRow.pageId}`,
				{
					accessToken: pageTokenRow.accessToken,
					params: { fields: 'id,name' },
					endpointLabel: 'meta.auth.verify'
				}
			);
			return {
				valid: true,
				pageId: response.id,
				pageName: response.name ?? null,
				tokenSource: config.bootstrapMode,
				checkedAt
			};
		} catch (error: any) {
			return {
				valid: false,
				reason:
					error?.response?.data?.error?.message ||
					error?.response?.data?.message ||
					error?.message ||
					'Unknown Meta API error',
				checkedAt
			};
		}
	}

	async exchangeUserToken(shortLivedUserToken: string) {
		if (!shortLivedUserToken) {
			throw new BadRequestException('shortLivedUserToken is required');
		}

		const clientId = process.env.META_APP_ID;
		const clientSecret = process.env.META_APP_SECRET;
		if (!clientId || !clientSecret) {
			throw new BadRequestException(
				'META_APP_ID and META_APP_SECRET are required for Meta token exchange'
			);
		}

		try {
			const response = await this.metaApiService.requestToken<{
				access_token: string;
				token_type?: string;
				expires_in?: number;
			}>(
				{
					client_id: clientId,
					client_secret: clientSecret,
					grant_type: 'fb_exchange_token',
					fb_exchange_token: shortLivedUserToken
				},
				{
					endpointLabel: 'oauth_exchange_long_lived_user_token',
					config: {
						baseURL: process.env.META_GRAPH_API_BASE_URL || 'https://graph.facebook.com'
					}
				}
			);

			const expiresInSeconds = Number(response.expires_in ?? 0);
			const expiresAt =
				expiresInSeconds > 0
					? new Date(Date.now() + expiresInSeconds * 1000)
					: null;

			const userProfile = await this.metaApiService.get<{
				id: string;
				name?: string;
			}>('/me', {
				accessToken: response.access_token,
				params: {
					fields: 'id,name'
				},
				endpointLabel: 'me_profile_after_token_exchange'
			});

			const tokenRow = await this.upsertToken({
				platformScope: 'meta',
				accountType: 'user',
				metaAppId: clientId,
				userId: userProfile.id,
				pageId: null,
				instagramBusinessAccountId: null,
				accessToken: response.access_token,
				tokenType: response.token_type ?? 'Bearer',
				scopes: null,
				expiresAt,
				lastRefreshedAt: new Date(),
				lastValidatedAt: new Date(),
				isExpired: false,
				refreshStatus: 'active',
				lastError: null
			});

			return {
				statusCode: 200,
				message: 'Meta user token exchanged successfully',
				data: {
					userId: userProfile.id,
					userName: userProfile.name ?? null,
					tokenType: tokenRow.tokenType,
					expiresAt: tokenRow.expiresAt,
					accountType: tokenRow.accountType
				}
			};
		} catch (error: any) {
			throw new BadGatewayException(
				`Unable to exchange Meta user token: ${this.getErrorMessage(error)}`
			);
		}
	}

	async bootstrapManagedAssets(options?: {
		shortLivedUserToken?: string;
		pageId?: string;
	}) {
		try {
			const resolvedPageId = String(
				options?.pageId || process.env.META_PAGE_ID || ''
			).trim();
			const systemUserToken = this.resolveSystemUserToken();
			if (systemUserToken) {
				return await this.bootstrapKnownPageFromSystemUserToken({
					systemUserToken,
					pageId: resolvedPageId
				});
			}

			const bootstrapToken = this.resolveBootstrapUserToken(options?.shortLivedUserToken);
			if (bootstrapToken) {
				await this.exchangeUserToken(bootstrapToken);
			}

			const userToken = await this.getLatestUserToken();
			const accountsResponse = await this.metaApiService.get<{
				data?: Array<{
					id: string;
					name?: string;
					access_token?: string;
					tasks?: string[];
					instagram_business_account?: { id: string };
					category?: string;
				}>;
			}>('/me/accounts', {
				accessToken: userToken.accessToken,
				params: {
					fields: 'id,name,access_token,tasks,instagram_business_account,category'
				},
				endpointLabel: 'me_accounts_bootstrap'
			});

			const accounts = accountsResponse.data ?? [];
			if (!accounts.length) {
				throw new NotFoundException(
					'No managed Facebook pages were returned for the current Meta user token'
				);
			}

			const selectedPage =
				accounts.find((account) => account.id === options?.pageId) ||
				(options?.pageId ? null : null) ||
				accounts.find((account) => account.id === process.env.META_PAGE_ID) ||
				accounts[0];

			if (!selectedPage) {
				throw new NotFoundException(
					`Managed Facebook page ${options?.pageId} was not found for the current Meta user token`
				);
			}

			const pageToken = selectedPage.access_token;
			if (!pageToken) {
				throw new NotFoundException(
					'Meta did not return a page access token for the selected page'
				);
			}

			const pageTokenRow = await this.upsertToken({
				platformScope: 'meta',
				accountType: 'page',
				metaAppId: process.env.META_APP_ID || null,
				userId: userToken.userId ?? null,
				pageId: selectedPage.id,
				instagramBusinessAccountId: selectedPage.instagram_business_account?.id ?? null,
				accessToken: pageToken,
				tokenType: 'Bearer',
				scopes: selectedPage.tasks?.join(',') ?? null,
				expiresAt: userToken.expiresAt ?? null,
				lastRefreshedAt: new Date(),
				lastValidatedAt: new Date(),
				isExpired: false,
				refreshStatus: 'active',
				lastError: null
			});

			return {
				statusCode: 200,
				message: 'Meta managed assets bootstrapped successfully',
				data: {
					userToken: {
						userId: userToken.userId,
						expiresAt: userToken.expiresAt
					},
					selectedPage: {
						pageId: selectedPage.id,
						name: selectedPage.name ?? null,
						category: selectedPage.category ?? null,
						tasks: selectedPage.tasks ?? [],
						instagramBusinessAccountId:
							selectedPage.instagram_business_account?.id ?? null
					},
					pageToken: {
						storedTokenId: pageTokenRow.id,
						expiresAt: pageTokenRow.expiresAt
					},
					availablePages: accounts.map((account) => ({
						pageId: account.id,
						name: account.name ?? null,
						category: account.category ?? null,
						instagramBusinessAccountId:
							account.instagram_business_account?.id ?? null
					}))
				}
			};
		} catch (error: any) {
			throw new BadGatewayException(
				`Unable to bootstrap Meta managed assets: ${this.getErrorMessage(error)}`
			);
		}
	}

	private async bootstrapKnownPageFromSystemUserToken(options: {
		systemUserToken: string;
		pageId: string;
	}) {
		if (!options.pageId) {
			throw new BadRequestException(
				'META_PAGE_ID or pageId is required for Meta system-user bootstrap'
			);
		}

		const pageDetails = await this.metaApiService.get<{
			id: string;
			name?: string;
			category?: string;
			access_token?: string;
			instagram_business_account?: { id: string };
		}>(`/${options.pageId}`, {
			accessToken: options.systemUserToken,
			params: {
				fields: 'id,name,category,access_token,instagram_business_account'
			},
			endpointLabel: 'page_bootstrap_from_system_user'
		});

		if (!pageDetails?.id) {
			throw new NotFoundException(
				`Meta did not return page ${options.pageId} for system-user bootstrap`
			);
		}

		const pageToken = String(pageDetails.access_token || '').trim();
		if (!pageToken) {
			throw new NotFoundException(
				'Meta did not return a page access token for the configured page'
			);
		}

		const pageTokenRow = await this.upsertToken({
			platformScope: 'meta',
			accountType: 'page',
			metaAppId: process.env.META_APP_ID || null,
			userId: null,
			pageId: pageDetails.id,
			instagramBusinessAccountId:
				pageDetails.instagram_business_account?.id ??
				process.env.META_INSTAGRAM_ACCOUNT_ID ??
				null,
			accessToken: pageToken,
			tokenType: 'Bearer',
			scopes: 'system_user_page_token',
			expiresAt: null,
			lastRefreshedAt: new Date(),
			lastValidatedAt: new Date(),
			isExpired: false,
			refreshStatus: 'active',
			lastError: null
		});

		return {
			statusCode: 200,
			message: 'Meta managed assets bootstrapped successfully',
			data: {
				authSource: 'system_user',
				selectedPage: {
					pageId: pageDetails.id,
					name: pageDetails.name ?? null,
					category: pageDetails.category ?? null,
					instagramBusinessAccountId:
						pageDetails.instagram_business_account?.id ??
						process.env.META_INSTAGRAM_ACCOUNT_ID ??
						null
				},
				pageToken: {
					storedTokenId: pageTokenRow.id,
					expiresAt: pageTokenRow.expiresAt
				}
			}
		};
	}

	async getEffectivePageToken(pageId?: string) {
		const resolvedPageId = pageId || process.env.META_PAGE_ID || null;
		let pageTokenRow = await this.metaAccountTokensRepo.findOne({
			where: {
				accountType: 'page',
				...(resolvedPageId ? { pageId: resolvedPageId } : {})
			},
			order: [['updatedAt', 'DESC']]
		});

		if (!pageTokenRow && this.resolveSystemUserToken()) {
			await this.bootstrapManagedAssets({ pageId: resolvedPageId ?? undefined });
			pageTokenRow = await this.metaAccountTokensRepo.findOne({
				where: {
					accountType: 'page',
					...(resolvedPageId ? { pageId: resolvedPageId } : {})
				},
				order: [['updatedAt', 'DESC']]
			});
		}

		if (!pageTokenRow && resolvedPageId) {
			throw new NotFoundException(
				`No stored Meta page token found for page ${resolvedPageId}. Run auth/bootstrap first.`
			);
		}

		if (!pageTokenRow) {
			throw new NotFoundException(
				'No stored Meta page token found. Run auth/bootstrap first.'
			);
		}

		return pageTokenRow;
	}

	private async getLatestUserToken() {
		const tokenRow = await this.metaAccountTokensRepo.findOne({
			where: {
				accountType: 'user'
			},
			order: [['updatedAt', 'DESC']]
		});

		if (!tokenRow) {
			throw new NotFoundException(
				'No stored Meta user token found. Exchange a short-lived token first.'
			);
		}

		return tokenRow;
	}

	private resolveBootstrapUserToken(shortLivedUserToken?: string) {
		const directToken = String(shortLivedUserToken || '').trim();
		if (directToken) {
			return directToken;
		}

		const envToken = String(process.env.META_ACCESS_TOKEN || '').trim();
		return envToken || null;
	}

	private resolveSystemUserToken() {
		const token = String(process.env.META_SYSTEM_USER_TOKEN || '').trim();
		return token || null;
	}

	private async upsertToken(payload: MetaTokenRow) {
		const existing = await this.metaAccountTokensRepo.findOne({
			where: {
				accountType: payload.accountType,
				...(payload.userId ? { userId: payload.userId } : {}),
				...(payload.pageId ? { pageId: payload.pageId } : {})
			}
		});

		if (existing) {
			await existing.update(payload);
			return existing;
		}

		return await this.metaAccountTokensRepo.create(payload);
	}

	private getErrorMessage(error: any) {
		return (
			error?.response?.data?.error?.message ||
			error?.response?.data?.message ||
			error?.message ||
			'Unknown Meta API error'
		);
	}
}
