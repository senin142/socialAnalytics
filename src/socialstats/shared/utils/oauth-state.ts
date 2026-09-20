import { BadRequestException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

const DEFAULT_STATE_TTL_MS = 15 * 60_000;

/**
 * CSRF state for the manual OAuth flows in this module (LinkedIn, TikTok), as a self-verifying
 * signed value rather than a nonce held in a server-side map.
 *
 * Two reasons it is stateless: the microservice runs multi-instance, so the token exchange can
 * land on a different pod than the one that issued the state and a per-process map would reject
 * legitimate attempts; and the authorize -> copy from address bar -> exchange round trip is done
 * by hand, so the value must survive minutes without any server-side session.
 *
 * `purpose` is bound into the signature so a state minted for one platform cannot be replayed
 * against another.
 *
 * What this actually defends against: the flows here have no automatic callback — an admin
 * pastes a code in by hand — so the risk is an attacker talking an admin into pasting an
 * authorization code from the ATTACKER's account, which would bind this system to that account
 * and ingest its data as though it were ours. A code obtained outside a flow this server started
 * arrives with a state we never signed, and fails verification here.
 */
export function issueOAuthState(purpose: string, ttlMs: number = DEFAULT_STATE_TTL_MS) {
	const payload = `${randomUUID()}.${Date.now() + ttlMs}`;
	return `${payload}.${signOAuthState(purpose, payload)}`;
}

export function verifyOAuthState(purpose: string, state?: string) {
	if (!state) {
		throw new BadRequestException('state is required — pass the value returned alongside the authorize URL.');
	}

	const segments = state.split('.');
	if (segments.length !== 3) {
		throw new BadRequestException('state is malformed.');
	}

	const [nonce, expiresAt, signature] = segments;
	const expected = signOAuthState(purpose, `${nonce}.${expiresAt}`);
	const received = Buffer.from(signature, 'utf8');
	const computed = Buffer.from(expected, 'utf8');

	if (received.length !== computed.length || !timingSafeEqual(received, computed)) {
		throw new BadRequestException('state failed verification — restart the authorization from auth/authorize-url.');
	}
	if (!Number(expiresAt) || Number(expiresAt) < Date.now()) {
		throw new BadRequestException('state has expired — restart the authorization from auth/authorize-url.');
	}
}

function signOAuthState(purpose: string, payload: string) {
	// JWT_SECRET already gates every authenticated route in this app, so it is the existing
	// trust anchor; a per-platform key would be one more secret to rotate for no gain.
	const secret = process.env.JWT_SECRET;
	if (!secret) {
		throw new Error('JWT_SECRET must be configured to sign OAuth state parameters.');
	}
	return createHmac('sha256', secret).update(`${purpose}:${payload}`).digest('hex');
}
