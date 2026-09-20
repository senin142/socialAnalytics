import { LinkedinAccountTokens } from '../../../database/entity';
import {
	BadRequestException,
	Inject,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import axios from 'axios';
import { issueOAuthState, verifyOAuthState } from '../../shared/utils/oauth-state';

const AUTHORIZATION_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const ACCESS_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

/**
 * LinkedIn's Community Management API (organization analytics) is a Vetted Product — the app
 * must be approved for Development Tier, then Standard Tier (with a screencast demo) before
 * it can read another organization's follower/page/share statistics at all. Until that
 * approval + an admin's OAuth consent exist, every call here fails with a clear
 * "not configured" / "not authorized" error rather than crashing ingestion.
 *
 * Token lifecycle differs from the Google/Meta services in this module: standard-tier LinkedIn
 * apps are NOT issued a refresh_token (that requires Marketing Developer Platform partner
 * status) — access tokens last ~60 days and once expired require an admin to click back
 * through the OAuth consent screen (getAuthorizationUrl -> LinkedIn redirects to
 * LINKEDIN_REDIRECT_URI with a `code` -> exchangeAuthorizationCode). If a refresh_token
 * *is* present (MDP-approved apps only) it's used automatically; otherwise getAccessToken
 * throws a message telling the admin to re-authorize instead of retrying forever.
 */
@Injectable()
export class LinkedinAuthService implements OnModuleInit {
	private readonly logger = new Logger(LinkedinAuthService.name);
	private readonly requestTimeoutMs = Number(process.env.LINKEDIN_HTTP_TIMEOUT_MS ?? 15000);
	private readonly stateTtlMs = Number(process.env.LINKEDIN_OAUTH_STATE_TTL_MS ?? 15 * 60_000);

	constructor(
		@Inject('LINKEDIN_ACCOUNT_TOKENS_REPOSITORY')
		private readonly linkedinAccountTokensRepo: typeof LinkedinAccountTokens
	) { }

	async onModuleInit() {
		await this.linkedinAccountTokensRepo.sync();
	}

	getConfigurationStatus() {
		const clientId = process.env.LINKEDIN_CLIENT_ID || null;
		const clientSecret = Boolean(process.env.LINKEDIN_CLIENT_SECRET);
		const redirectUri = process.env.LINKEDIN_REDIRECT_URI || null;
		const organizationUrn = this.resolveOrganizationUrn();

		return {
			clientIdConfigured: Boolean(clientId),
			clientSecretConfigured: clientSecret,
			redirectUriConfigured: Boolean(redirectUri),
			organizationConfigured: Boolean(organizationUrn),
			organizationUrn,
			apiVersion: this.resolveApiVersion()
		};
	}

	issueState() {
		return issueOAuthState('linkedin-oauth', this.stateTtlMs);
	}

	getAuthorizationUrl(state: string) {
		const clientId = process.env.LINKEDIN_CLIENT_ID;
		const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
		if (!clientId || !redirectUri) {
			throw new BadRequestException(
				'LINKEDIN_CLIENT_ID and LINKEDIN_REDIRECT_URI must be configured before an admin can authorize this app.'
			);
		}

		const params = new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: redirectUri,
			state,
			// rw_organization_admin is the permission every organization analytics endpoint
			// (Follower/Page/Share Statistics) documents — it's restricted to members with the
			// ADMINISTRATOR role on the target organization, so whoever authorizes this app
			// must themselves be a page admin, not just an app developer.
			scope: 'rw_organization_admin'
		});

		return `${AUTHORIZATION_URL}?${params.toString()}`;
	}

	async exchangeAuthorizationCode(code: string, state?: string) {
		verifyOAuthState('linkedin-oauth', state);
		const clientId = process.env.LINKEDIN_CLIENT_ID;
		const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
		const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
		const organizationUrn = this.resolveOrganizationUrn();

		if (!clientId || !clientSecret || !redirectUri) {
			throw new BadRequestException(
				'LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET and LINKEDIN_REDIRECT_URI must be configured before exchanging an authorization code.'
			);
		}
		if (!organizationUrn) {
			throw new BadRequestException(
				'LINKEDIN_ORGANIZATION_ID must be configured so ingested stats can be tied to an organization URN.'
			);
		}

		const response = await axios.post(
			ACCESS_TOKEN_URL,
			new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: redirectUri,
				client_id: clientId,
				client_secret: clientSecret
			}),
			{
				timeout: this.requestTimeoutMs,
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
			}
		);

		return this.persistTokenResponse(organizationUrn, response.data);
	}

	/**
	 * Returns a usable access token or throws with an actionable message. Never silently
	 * fails — ingestion cron jobs are expected to catch this and record it as a normal
	 * (non-alarming) "not configured yet" gap via IngestionControlService/DataCoverageService
	 * rather than a real failure, since this is expected before credentials exist.
	 */
	async getAccessToken() {
		const organizationUrn = this.resolveOrganizationUrn();
		if (!organizationUrn) {
			throw new Error(
				'LinkedIn is not configured yet: set LINKEDIN_ORGANIZATION_ID (and the OAuth env vars) then authorize via GET .../linkedin/auth/authorize-url.'
			);
		}

		const tokenRow = await this.linkedinAccountTokensRepo.findOne({
			where: { organizationUrn },
			order: [['updatedAt', 'DESC']]
		});

		if (!tokenRow) {
			throw new Error(
				`No stored LinkedIn access token for ${organizationUrn}. An admin must authorize this app first: GET .../linkedin/auth/authorize-url, then complete the LinkedIn consent screen.`
			);
		}

		const expiresAt = tokenRow.expiresAt ? new Date(tokenRow.expiresAt).getTime() : 0;
		const isExpiringSoon = expiresAt - Date.now() < 60_000;
		if (!isExpiringSoon) {
			return { accessToken: tokenRow.accessToken, organizationUrn };
		}

		if (tokenRow.refreshToken) {
			return await this.refreshAccessToken(tokenRow);
		}

		throw new Error(
			`LinkedIn access token for ${organizationUrn} expired on ${tokenRow.expiresAt}. Standard-tier LinkedIn apps are not issued a refresh_token — an admin must re-authorize: GET .../linkedin/auth/authorize-url.`
		);
	}

	resolveApiVersion() {
		// LinkedIn versions its REST API monthly (YYYYMM) and each version is only supported
		// for roughly a year before sunset — this must be bumped periodically (see the
		// deprecation notices on developers' Microsoft Learn docs) rather than left to rot.
		return process.env.LINKEDIN_API_VERSION || '202608';
	}

	resolveOrganizationUrn() {
		const rawUrn = String(process.env.LINKEDIN_ORGANIZATION_URN || '').trim();
		if (rawUrn) {
			return rawUrn;
		}
		const id = String(process.env.LINKEDIN_ORGANIZATION_ID || '').trim();
		return id ? `urn:li:organization:${id}` : null;
	}

	private async refreshAccessToken(tokenRow: LinkedinAccountTokens) {
		const clientId = process.env.LINKEDIN_CLIENT_ID;
		const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
		if (!clientId || !clientSecret) {
			throw new Error('LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET missing; cannot refresh LinkedIn token.');
		}

		try {
			const response = await axios.post(
				ACCESS_TOKEN_URL,
				new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: tokenRow.refreshToken as string,
					client_id: clientId,
					client_secret: clientSecret
				}),
				{
					timeout: this.requestTimeoutMs,
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
				}
			);

			const updated = await this.persistTokenResponse(tokenRow.organizationUrn, response.data, tokenRow);
			return { accessToken: updated.accessToken, organizationUrn: updated.organizationUrn };
		} catch (err: any) {
			const message = err?.response?.data?.error_description || err?.message || 'Unknown error';
			await tokenRow.update({ refreshStatus: 'failed', lastError: message });
			throw new Error(`Failed to refresh LinkedIn access token: ${message}. Re-authorize via GET .../linkedin/auth/authorize-url.`);
		}
	}

	private async persistTokenResponse(
		organizationUrn: string,
		data: {
			access_token: string;
			expires_in?: number;
			refresh_token?: string;
			refresh_token_expires_in?: number;
			scope?: string;
			token_type?: string;
		},
		existing?: LinkedinAccountTokens
	) {
		const expiresAt = data.expires_in
			? new Date(Date.now() + data.expires_in * 1000)
			: null;
		const refreshTokenExpiresAt = data.refresh_token_expires_in
			? new Date(Date.now() + data.refresh_token_expires_in * 1000)
			: existing?.refreshTokenExpiresAt ?? null;

		const payload = {
			organizationUrn,
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? existing?.refreshToken ?? null,
			tokenType: data.token_type ?? 'Bearer',
			scopes: data.scope ?? existing?.scopes ?? null,
			expiresAt,
			refreshTokenExpiresAt,
			lastRefreshedAt: new Date(),
			refreshStatus: 'active',
			lastError: null
		};

		if (existing) {
			await existing.update(payload);
			return existing;
		}

		const row = await this.linkedinAccountTokensRepo.findOne({ where: { organizationUrn } });
		if (row) {
			await row.update(payload);
			return row;
		}

		return await this.linkedinAccountTokensRepo.create(payload);
	}
}
