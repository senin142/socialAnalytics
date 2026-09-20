import { Injectable } from '@nestjs/common';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

export type YoutubeAccessTokenResponse = {
	accessToken: string;
	expiresInSeconds: number;
	expiresAt: string;
	tokenType: string;
	source:
		| 'oauth_refresh_token'
		| 'auth_file_access_token'
		| 'env_access_token_fallback';
};

@Injectable()
export class YoutubeAuthService {
	private cachedToken: YoutubeAccessTokenResponse | null = null;
	private cachedAuthFailure: { message: string; expiresAt: number } | null = null;
	private readonly requestTimeoutMs = Number(process.env.YOUTUBE_HTTP_TIMEOUT_MS ?? 15000);
	private readonly authFailureTtlMs = Number(process.env.YOUTUBE_AUTH_FAILURE_TTL_MS ?? 30_000);

	async getAccessToken(options?: { forceRefresh?: boolean }) {
		if (this.cachedAuthFailure && !options?.forceRefresh) {
			if (this.cachedAuthFailure.expiresAt > Date.now()) {
				throw new Error(this.cachedAuthFailure.message);
			}

			this.cachedAuthFailure = null;
		}

		if (this.cachedToken && !options?.forceRefresh) {
			const expiresAtMs = new Date(this.cachedToken.expiresAt).getTime();
			const now = Date.now();
			if (expiresAtMs - now > 60_000) {
				return this.cachedToken;
			}
		}

		const envRefreshToken = this.readEnvToken('YOUTUBE_REFRESH_TOKEN');
		const fileRefreshToken = await this.getRefreshTokenFromFile();
		const refreshToken = this.pickRefreshToken(envRefreshToken, fileRefreshToken);
		const clientId = process.env.YOUTUBE_CLIENT_ID;
		const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

		if (!clientId || !clientSecret || !refreshToken) {
			const fallbackAccessToken = await this.getFallbackAccessToken(envRefreshToken);
			if (fallbackAccessToken) {
				this.cachedToken = fallbackAccessToken;
				return this.cachedToken;
			}

			throw new Error([
				'Missing YouTube OAuth credentials for token refresh.',
				'Required env: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN.',
				'If YOUTUBE_REFRESH_TOKEN contains a ya29 access token, replace it with a real refresh token or remove it so the auth file can be used.'
			].join(' '));
		}

		try {
			const response = await axios.post(
				'https://oauth2.googleapis.com/token',
				new URLSearchParams({
					client_id: clientId,
					client_secret: clientSecret,
					refresh_token: refreshToken,
					grant_type: 'refresh_token'
				}),
				{
					timeout: this.requestTimeoutMs,
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded'
					}
				}
			);

			const expiresInSeconds = Number(response.data.expires_in ?? 3600);
			const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
			this.cachedAuthFailure = null;
			this.cachedToken = {
				accessToken: response.data.access_token as string,
				expiresInSeconds,
				expiresAt,
				tokenType: (response.data.token_type as string) || 'Bearer',
				source: 'oauth_refresh_token'
			};

			return this.cachedToken;
		} catch (err: any) {
			this.cachedToken = null;
			const fallbackAccessToken = await this.getFallbackAccessToken(envRefreshToken);
			if (fallbackAccessToken) {
				this.cachedAuthFailure = null;
				this.cachedToken = fallbackAccessToken;
				return this.cachedToken;
			}

			const authFailureMessage = this.buildAuthFailureMessage(err);
			if (this.shouldCacheAuthFailure(err)) {
				this.cachedAuthFailure = {
					message: authFailureMessage,
					expiresAt: Date.now() + this.authFailureTtlMs
				};
			}
			throw new Error(authFailureMessage);
		}
	}

	invalidateCachedToken() {
		this.cachedToken = null;
		this.cachedAuthFailure = null;
	}

	async getAuthDebugInfo() {
		const envRefreshToken = this.readEnvToken('YOUTUBE_REFRESH_TOKEN');
		const authFilePath = this.getAuthFilePath();
		const fileAuth = await this.readAuthFile();
		const fileRefreshToken = typeof fileAuth?.refresh_token === 'string'
			? fileAuth.refresh_token.trim()
			: undefined;
		const fileAccessToken = typeof fileAuth?.access_token === 'string'
			? fileAuth.access_token.trim()
			: undefined;
		const fileScope = typeof fileAuth?.scope === 'string'
			? fileAuth.scope
					.split(/\s+/)
					.map(scope => scope.trim())
					.filter(Boolean)
			: [];

		return {
			authFilePath,
			envRefreshTokenPresent: Boolean(envRefreshToken),
			envRefreshTokenType: this.describeTokenType(envRefreshToken),
			fileRefreshTokenPresent: Boolean(fileRefreshToken),
			fileAccessTokenPresent: Boolean(fileAccessToken),
			fileScope,
			effectiveRefreshTokenSource: this.pickRefreshToken(envRefreshToken, fileRefreshToken)
				? this.isLikelyRefreshToken(envRefreshToken)
					? 'env'
					: 'file'
				: 'none',
			cachedTokenSource: this.cachedToken?.source ?? null
		};
	}

	private readEnvToken(key: string) {
		const value = process.env[key]?.trim();
		return value ? value : undefined;
	}

	private isLikelyRefreshToken(token?: string) {
		return Boolean(token?.startsWith('1//'));
	}

	private isLikelyAccessToken(token?: string) {
		return Boolean(token?.startsWith('ya29.'));
	}

	private describeTokenType(token?: string) {
		if (this.isLikelyRefreshToken(token)) return 'refresh_token';
		if (this.isLikelyAccessToken(token)) return 'access_token';
		return token ? 'unknown' : 'missing';
	}

	private pickRefreshToken(...tokens: Array<string | undefined>) {
		return tokens.find(token => this.isLikelyRefreshToken(token));
	}

	private async getFallbackAccessToken(envRefreshToken?: string) {
		if (this.isLikelyAccessToken(envRefreshToken)) {
			return this.buildAccessTokenResponse(envRefreshToken, 'env_access_token_fallback');
		}

		return this.getAccessTokenFromFile();
	}

	private async getRefreshTokenFromFile() {
		try {
			const parsed = await this.readAuthFile();
			return parsed.refresh_token as string;
		} catch {
			return undefined;
		}
	}

	private async getAccessTokenFromFile() {
		try {
			const parsed = await this.readAuthFile();
			if (!this.isLikelyAccessToken(parsed.access_token)) {
				return undefined;
			}

			return this.buildAccessTokenResponse(
				parsed.access_token as string,
				'auth_file_access_token',
				parsed.expires_in,
				parsed.token_type
			);
		} catch {
			return undefined;
		}
	}

	private async readAuthFile() {
		const authFilePath = this.getAuthFilePath();
		const raw = await fs.readFile(authFilePath, 'utf-8');
		return JSON.parse(raw);
	}

	private buildAccessTokenResponse(
		accessToken: string,
		source: YoutubeAccessTokenResponse['source'],
		expiresIn?: number,
		tokenType?: string
	): YoutubeAccessTokenResponse {
		const expiresInSeconds = Number(expiresIn ?? 3600);
		const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
		return {
			accessToken,
			expiresInSeconds,
			expiresAt,
			tokenType: tokenType || 'Bearer',
			source
		};
	}

	private getAuthFilePath() {
		return (
			process.env.YOUTUBE_AUTH_FILE_PATH ||
			path.join(process.cwd(), 'youtube.auth.json')
		);
	}

	private buildAuthFailureMessage(err: any) {
		const upstreamMessage =
			err?.response?.data?.error_description ||
			err?.response?.data?.error?.message ||
			err?.message ||
			'Unable to refresh YouTube OAuth access token.';

		if (this.shouldCacheAuthFailure(err)) {
			return `${upstreamMessage} Refresh the YouTube OAuth credentials in YOUTUBE_REFRESH_TOKEN or youtube.auth.json, or provide a valid temporary access token until the refresh token is replaced.`;
		}

		return upstreamMessage;
	}

	private shouldCacheAuthFailure(err: any) {
		const status = err?.response?.status;
		const body = JSON.stringify(err?.response?.data || '').toLowerCase();
		if (status !== 400 && status !== 401) {
			return false;
		}

		return (
			body.includes('invalid_grant') ||
			body.includes('expired') ||
			body.includes('revoked') ||
			body.includes('invalid_client')
		);
	}
}
