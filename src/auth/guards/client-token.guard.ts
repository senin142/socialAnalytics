import {
	CanActivate,
	ExecutionContext,
	Injectable,
	UnauthorizedException
} from '@nestjs/common';
import { SocialStatsClientTokenService } from '../../socialstats/shared/services/socialstats-client-token.service';

/**
 * Guards the socialstats "client" controllers (Meta / YouTube) which are intentionally
 * excluded from the global JWT auth (via @Public()) because they're consumed by a
 * separate, non-admin-login client surface. This guard enforces the HMAC-signed
 * client token issued by SocialStatsClientTokenService instead.
 *
 * The token is expected either in the `x-socialstats-client-token` header or, as a
 * fallback, in a `clientToken` query parameter (useful for browser-navigated GET
 * endpoints where setting a custom header isn't practical).
 */
@Injectable()
export class ClientTokenGuard implements CanActivate {
	constructor(private readonly clientTokenService: SocialStatsClientTokenService) { }

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest();
		const token = this.extractToken(request);

		if (!token) {
			throw new UnauthorizedException('Missing socialstats client token');
		}

		// Throws UnauthorizedException on invalid/expired/malformed tokens.
		this.clientTokenService.assertToken(token);

		return true;
	}

	private extractToken(request: any): string | null {
		const headerToken =
			request.headers?.['x-socialstats-client-token'] ||
			request.headers?.['x-client-token'];

		if (typeof headerToken === 'string' && headerToken.trim()) {
			return headerToken.trim();
		}

		const authHeader = request.headers?.authorization;
		if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
			const bearerToken = authHeader.slice('Bearer '.length).trim();
			if (bearerToken) {
				return bearerToken;
			}
		}

		const queryToken = request.query?.clientToken;
		if (typeof queryToken === 'string' && queryToken.trim()) {
			return queryToken.trim();
		}

		return null;
	}
}
