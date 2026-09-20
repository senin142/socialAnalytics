import { TiktokAccountTokens } from '../../../database/entity';
import {
	BadRequestException,
	Inject,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import axios from 'axios';
import { issueOAuthState, verifyOAuthState } from '../../shared/utils/oauth-state';

const AUTHORIZATION_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const ACCESS_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';

// TikTok's Feb-2024 scope migration stripped the stats/profile fields out of user.info.basic:
// follower_count & friends now require user.info.stats, and bio/username/is_verified require
// user.info.profile. Requesting basic alone yields a 200 with those fields silently missing,
// so all three are requested and each must be ticked on in the app's Login Kit config too —
// the consent screen only offers what the app is registered for.
const DEFAULT_SCOPES = 'user.info.basic,user.info.profile,user.info.stats,video.list';

/**
 * TikTok Login Kit OAuth. Three things here differ materially from the LinkedIn/Meta/Google
 * services in this module, all of them forced by TikTok's platform rules:
 *
 * 1. ACCESS TOKENS LIVE 24 HOURS. Not 60 days (LinkedIn) — one day. Unlike LinkedIn, though,
 *    TikTok *does* issue a refresh token to ordinary apps, so this renews unattended. The
 *    refresh buffer is deliberately wide (30 min, vs LinkedIn's 60 s) and a dedicated cron in
 *    TiktokIngestService refreshes well ahead of expiry, because a token that dies between
 *    daily runs would otherwise take the next run down with it.
 *
 * 2. REFRESH TOKENS ROTATE. Every refresh returns a NEW refresh_token and burns the one just
 *    used. Persisting it is not an optimisation — drop a rotated token and the only recovery
 *    is a human re-authorizing. That's why persistTokenResponse writes before anything else
 *    can fail, and why a failed refresh marks the row rather than retrying blindly.
 *
 * 3. CREDENTIALS ARE `client_key`, NOT `client_id`. TikTok is alone among the platforms in
 *    this module on that naming; sending client_id fails with an unhelpful error.
 *
 * PKCE is intentionally not implemented: TikTok mandates it for desktop/iOS/Android clients,
 * but this is a confidential server-side web app where the secret never leaves the backend
 * and `state` covers CSRF. Adding it would mean persisting a code_verifier between the
 * authorize-url call and the exchange for no security gain here.
 */
@Injectable()
export class TiktokAuthService implements OnModuleInit {
	private readonly logger = new Logger(TiktokAuthService.name);
	private readonly requestTimeoutMs = Number(process.env.TIKTOK_HTTP_TIMEOUT_MS ?? 15000);
	private readonly refreshBufferMs = Number(process.env.TIKTOK_TOKEN_REFRESH_BUFFER_MS ?? 30 * 60_000);
	private readonly stateTtlMs = Number(process.env.TIKTOK_OAUTH_STATE_TTL_MS ?? 15 * 60_000);

	constructor(
		@Inject('TIKTOK_ACCOUNT_TOKENS_REPOSITORY')
		private readonly tiktokAccountTokensRepo: typeof TiktokAccountTokens
	) { }

	async onModuleInit() {
		await this.tiktokAccountTokensRepo.sync();
	}

	getConfigurationStatus() {
		return {
			clientKeyConfigured: Boolean(process.env.TIKTOK_CLIENT_KEY),
			clientSecretConfigured: Boolean(process.env.TIKTOK_CLIENT_SECRET),
			redirectUriConfigured: Boolean(process.env.TIKTOK_REDIRECT_URI),
			scopes: this.resolveScopes()
		};
	}

	issueState() {
		return issueOAuthState('tiktok-oauth', this.stateTtlMs);
	}

	getAuthorizationUrl(state: string) {
		const clientKey = process.env.TIKTOK_CLIENT_KEY;
		const redirectUri = process.env.TIKTOK_REDIRECT_URI;
		if (!clientKey || !redirectUri) {
			throw new BadRequestException(
				'TIKTOK_CLIENT_KEY and TIKTOK_REDIRECT_URI must be configured before an account can authorize this app.'
			);
		}

		const params = new URLSearchParams({
			client_key: clientKey,
			scope: this.resolveScopes(),
			response_type: 'code',
			redirect_uri: redirectUri,
			state
		});

		return `${AUTHORIZATION_URL}?${params.toString()}`;
	}

	async exchangeAuthorizationCode(code: string, state?: string) {
		verifyOAuthState('tiktok-oauth', state);
		const { clientKey, clientSecret, redirectUri } = this.requireCredentials(true);

		// TikTok URL-encodes the `code` in the redirect; if an admin pastes it straight out of
		// the address bar it can still carry %2A etc. Decoding here keeps that from surfacing
		// as an opaque "invalid_grant".
		const response = await this.postForm(ACCESS_TOKEN_URL, {
			client_key: clientKey,
			client_secret: clientSecret,
			code: decodeURIComponent(code),
			grant_type: 'authorization_code',
			redirect_uri: redirectUri as string
		});

		return await this.persistTokenResponse(response);
	}

	/**
	 * Returns a usable access token, refreshing it first when it is at or near expiry. Throws
	 * with an actionable message rather than returning null — callers treat a throw here as a
	 * "not configured / needs re-auth" coverage gap, not an outage.
	 */
	async getAccessToken() {
		const tokenRow = await this.getActiveTokenRow();

		const expiresAt = tokenRow.expiresAt ? new Date(tokenRow.expiresAt).getTime() : 0;
		if (expiresAt - Date.now() > this.refreshBufferMs) {
			return { accessToken: tokenRow.accessToken, openId: tokenRow.openId };
		}

		const refreshed = await this.refreshAccessToken(tokenRow);
		return { accessToken: refreshed.accessToken, openId: refreshed.openId };
	}

	/** Used by the scheduled refresh job; a no-op when the token is still comfortably valid. */
	async refreshIfNeeded() {
		const tokenRow = await this.getActiveTokenRow();
		const expiresAt = tokenRow.expiresAt ? new Date(tokenRow.expiresAt).getTime() : 0;
		if (expiresAt - Date.now() > this.refreshBufferMs) {
			return { refreshed: false, openId: tokenRow.openId, expiresAt: tokenRow.expiresAt };
		}

		const refreshed = await this.refreshAccessToken(tokenRow);
		return { refreshed: true, openId: refreshed.openId, expiresAt: refreshed.expiresAt };
	}

	/**
	 * Revokes the stored token with TikTok and clears it locally. TikTok's Developer Terms
	 * require that access be given up — and the data derived from it stop being refreshed —
	 * once the account holder withdraws consent, so this marks the row revoked rather than
	 * deleting it, leaving TiktokIngestService's retention job to drop the dependent content
	 * rows on its next pass.
	 */
	async revokeAccess() {
		const { clientKey, clientSecret } = this.requireCredentials(false);
		const tokenRow = await this.tiktokAccountTokensRepo.findOne({
			where: { revokedAt: null },
			order: [['updatedAt', 'DESC']]
		});

		if (!tokenRow) {
			throw new BadRequestException('There is no active TikTok authorization to revoke.');
		}

		try {
			await this.postForm(REVOKE_TOKEN_URL, {
				client_key: clientKey,
				client_secret: clientSecret,
				token: tokenRow.accessToken
			});
		} catch (err) {
			// A token TikTok already considers dead still has to be cleared on our side —
			// leaving it would keep the ingest crons trying to use a revoked grant.
			this.logger.warn(`TikTok rejected the revoke call, clearing the local token anyway: ${this.describeOauthError(err)}`);
		}

		await tokenRow.update({
			revokedAt: new Date(),
			refreshStatus: 'revoked',
			accessToken: '',
			refreshToken: null
		});

		return { openId: tokenRow.openId, revokedAt: tokenRow.revokedAt };
	}

	async getTokenStatus() {
		const tokenRow = await this.tiktokAccountTokensRepo.findOne({
			order: [['updatedAt', 'DESC']]
		});

		if (!tokenRow) {
			return { authorized: false, openId: null };
		}

		return {
			authorized: !tokenRow.revokedAt,
			openId: tokenRow.openId,
			scopes: tokenRow.scopes,
			expiresAt: tokenRow.expiresAt,
			refreshTokenExpiresAt: tokenRow.refreshTokenExpiresAt,
			lastRefreshedAt: tokenRow.lastRefreshedAt,
			refreshStatus: tokenRow.refreshStatus,
			lastError: tokenRow.lastError,
			revokedAt: tokenRow.revokedAt
		};
	}

	private resolveScopes() {
		return process.env.TIKTOK_SCOPES || DEFAULT_SCOPES;
	}

	private requireCredentials(needsRedirectUri: boolean) {
		const clientKey = process.env.TIKTOK_CLIENT_KEY;
		const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
		const redirectUri = process.env.TIKTOK_REDIRECT_URI;

		if (!clientKey || !clientSecret) {
			throw new BadRequestException(
				'TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET must be configured.'
			);
		}
		if (needsRedirectUri && !redirectUri) {
			throw new BadRequestException('TIKTOK_REDIRECT_URI must be configured.');
		}

		return { clientKey, clientSecret, redirectUri };
	}

	private async getActiveTokenRow() {
		const tokenRow = await this.tiktokAccountTokensRepo.findOne({
			where: { revokedAt: null },
			order: [['updatedAt', 'DESC']]
		});

		if (!tokenRow) {
			throw new Error(
				'No stored TikTok access token. The account holder must authorize this app first: GET .../tiktok/auth/authorize-url, then complete the TikTok consent screen.'
			);
		}

		const refreshExpiresAt = tokenRow.refreshTokenExpiresAt
			? new Date(tokenRow.refreshTokenExpiresAt).getTime()
			: null;
		if (refreshExpiresAt && refreshExpiresAt <= Date.now()) {
			throw new Error(
				`TikTok refresh token for ${tokenRow.openId} expired on ${tokenRow.refreshTokenExpiresAt}. Refresh tokens last 365 days and cannot be renewed once lapsed — re-authorize via GET .../tiktok/auth/authorize-url.`
			);
		}

		return tokenRow;
	}

	private async refreshAccessToken(tokenRow: TiktokAccountTokens) {
		const { clientKey, clientSecret } = this.requireCredentials(false);

		if (!tokenRow.refreshToken) {
			throw new Error(
				`No TikTok refresh token stored for ${tokenRow.openId}; re-authorize via GET .../tiktok/auth/authorize-url.`
			);
		}

		try {
			const response = await this.postForm(ACCESS_TOKEN_URL, {
				client_key: clientKey,
				client_secret: clientSecret,
				grant_type: 'refresh_token',
				refresh_token: tokenRow.refreshToken
			});

			return await this.persistTokenResponse(response, tokenRow);
		} catch (err) {
			const message = this.describeOauthError(err);
			await tokenRow.update({ refreshStatus: 'failed', lastError: message });
			throw new Error(
				`Failed to refresh TikTok access token: ${message}. Re-authorize via GET .../tiktok/auth/authorize-url.`
			);
		}
	}

	private async postForm(url: string, form: Record<string, string>) {
		const response = await axios.post(url, new URLSearchParams(form), {
			timeout: this.requestTimeoutMs,
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				// TikTok rejects cached OAuth responses on some edges without this.
				'Cache-Control': 'no-cache'
			}
		});

		// The OAuth endpoints report failures in the body at HTTP 200, unlike the rest of the
		// v2 API which uses a nested `error.code`. Surface that as a thrown error so callers
		// don't persist an empty token.
		if (response.data?.error) {
			const error: any = new Error(
				response.data.error_description || response.data.error
			);
			error.tiktokOauthError = response.data.error;
			throw error;
		}

		return response.data;
	}

	private async persistTokenResponse(
		data: {
			access_token: string;
			expires_in?: number;
			open_id?: string;
			refresh_token?: string;
			refresh_expires_in?: number;
			scope?: string;
			token_type?: string;
		},
		existing?: TiktokAccountTokens
	) {
		const openId = data.open_id ?? existing?.openId;
		if (!openId) {
			throw new Error('TikTok did not return an open_id for this authorization.');
		}

		const payload = {
			openId,
			accessToken: data.access_token,
			// Rotation: TikTok invalidates the refresh token that was just used, so the new one
			// must overwrite it. Falling back to the existing value only covers the (spec-legal)
			// case of TikTok omitting it entirely.
			refreshToken: data.refresh_token ?? existing?.refreshToken ?? null,
			tokenType: data.token_type ?? 'Bearer',
			scopes: data.scope ?? existing?.scopes ?? null,
			expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
			refreshTokenExpiresAt: data.refresh_expires_in
				? new Date(Date.now() + data.refresh_expires_in * 1000)
				: existing?.refreshTokenExpiresAt ?? null,
			lastRefreshedAt: new Date(),
			refreshStatus: 'active',
			lastError: null,
			revokedAt: null
		};

		if (existing) {
			await existing.update(payload);
			return existing;
		}

		const row = await this.tiktokAccountTokensRepo.findOne({ where: { openId } });
		if (row) {
			await row.update(payload);
			return row;
		}

		return await this.tiktokAccountTokensRepo.create(payload);
	}

	private describeOauthError(error: any) {
		return (
			error?.response?.data?.error_description ||
			error?.response?.data?.error ||
			error?.message ||
			'Unknown TikTok OAuth error'
		);
	}
}
