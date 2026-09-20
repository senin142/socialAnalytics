import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

export type SocialStatsClientTokenPayload = {
	v: 1;
	iss: 'admin-microservice:socialstats';
	aud: 'socialstats-client';
	scope: string;
	sub: string | null;
	path: string | null;
	iat: number;
	nbf: number;
	exp: number;
	meta?: Record<string, string | number | boolean | null>;
};

export type CreateSocialStatsClientTokenOptions = {
	scope?: string;
	subject?: string;
	path?: string;
	expiresInSeconds?: number;
	notBeforeSeconds?: number;
	meta?: Record<string, string | number | boolean | null>;
};

export type VerifySocialStatsClientTokenOptions = {
	expectedScope?: string;
	expectedPath?: string;
	allowExpired?: boolean;
};

export type SocialStatsClientTokenVerificationResult = {
	valid: boolean;
	reason: string | null;
	payload: SocialStatsClientTokenPayload | null;
};

@Injectable()
export class SocialStatsClientTokenService {
	private readonly tokenPrefix = 'sst1';
	private readonly issuer = 'admin-microservice:socialstats';
	private readonly audience = 'socialstats-client';
	private readonly defaultScope = 'socialstats-client';
	private readonly defaultExpiresInSeconds = 60 * 60;

	createToken(
		options: CreateSocialStatsClientTokenOptions = {}
	): {
		token: string;
		payload: SocialStatsClientTokenPayload;
	} {
		const now = Math.floor(Date.now() / 1000);
		const payload: SocialStatsClientTokenPayload = {
			v: 1,
			iss: this.issuer,
			aud: this.audience,
			scope: options.scope || this.defaultScope,
			sub: options.subject || null,
			path: options.path || null,
			iat: now,
			nbf: now + Math.max(0, Math.floor(options.notBeforeSeconds ?? 0)),
			exp:
				now +
				Math.max(
					1,
					Math.floor(options.expiresInSeconds ?? this.defaultExpiresInSeconds)
				),
			...(options.meta ? { meta: options.meta } : {})
		};

		const payloadSegment = this.toBase64Url(JSON.stringify(payload));
		const signatureSegment = this.sign(payloadSegment);
		return {
			token: `${this.tokenPrefix}.${payloadSegment}.${signatureSegment}`,
			payload
		};
	}

	verifyToken(
		token: string,
		options: VerifySocialStatsClientTokenOptions = {}
	): SocialStatsClientTokenVerificationResult {
		const parts = String(token || '').split('.');
		if (parts.length !== 3 || parts[0] !== this.tokenPrefix) {
			return {
				valid: false,
				reason: 'invalid_format',
				payload: null
			};
		}

		const [, payloadSegment, signatureSegment] = parts;
		const expectedSignature = this.sign(payloadSegment);
		if (!this.safeEquals(signatureSegment, expectedSignature)) {
			return {
				valid: false,
				reason: 'invalid_signature',
				payload: null
			};
		}

		let payload: SocialStatsClientTokenPayload;
		try {
			payload = JSON.parse(this.fromBase64Url(payloadSegment)) as SocialStatsClientTokenPayload;
		} catch {
			return {
				valid: false,
				reason: 'invalid_payload',
				payload: null
			};
		}

		if (
			payload?.v !== 1 ||
			payload?.iss !== this.issuer ||
			payload?.aud !== this.audience
		) {
			return {
				valid: false,
				reason: 'invalid_claims',
				payload: null
			};
		}

		const now = Math.floor(Date.now() / 1000);
		if (payload.nbf > now) {
			return {
				valid: false,
				reason: 'not_yet_valid',
				payload
			};
		}

		if (!options.allowExpired && payload.exp <= now) {
			return {
				valid: false,
				reason: 'expired',
				payload
			};
		}

		if (options.expectedScope && payload.scope !== options.expectedScope) {
			return {
				valid: false,
				reason: 'scope_mismatch',
				payload
			};
		}

		if (options.expectedPath && payload.path !== options.expectedPath) {
			return {
				valid: false,
				reason: 'path_mismatch',
				payload
			};
		}

		return {
			valid: true,
			reason: null,
			payload
		};
	}

	assertToken(
		token: string,
		options: VerifySocialStatsClientTokenOptions = {}
	): SocialStatsClientTokenPayload {
		const result = this.verifyToken(token, options);
		if (!result.valid || !result.payload) {
			throw new UnauthorizedException(
				`Invalid socialstats client token${result.reason ? `: ${result.reason}` : ''}`
			);
		}

		return result.payload;
	}

	private sign(payloadSegment: string) {
		return this.toBase64Url(
			createHmac('sha256', this.getSecret()).update(payloadSegment).digest()
		);
	}

	private getSecret() {
		const secret = process.env.SOCIALSTATS_CLIENT_TOKEN_SECRET?.trim();
		if (!secret) {
			throw new Error(
				'SOCIALSTATS_CLIENT_TOKEN_SECRET is required to create or verify socialstats client tokens'
			);
		}

		return secret;
	}

	private toBase64Url(value: string | Buffer) {
		return Buffer.from(value)
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/g, '');
	}

	private fromBase64Url(value: string) {
		const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
		const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
		return Buffer.from(padded, 'base64').toString('utf8');
	}

	private safeEquals(left: string, right: string) {
		const leftBuffer = Buffer.from(left);
		const rightBuffer = Buffer.from(right);
		if (leftBuffer.length !== rightBuffer.length) {
			return false;
		}

		return timingSafeEqual(leftBuffer, rightBuffer);
	}
}
