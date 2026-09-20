import { JwtAuthGuard, Roles } from '../../../auth';
import { RoleTypes } from '../../../enums';
import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { TiktokAuthService } from '../services/tiktok-auth.service';
import { TiktokQuotaService } from '../services/tiktok-quota.service';
import { TiktokService } from '../services/tiktok.service';

@Controller('admin/api/admin/socialstats/tiktok')
export class TiktokController {
	constructor(
		private readonly tiktokAuthService: TiktokAuthService,
		private readonly tiktokQuotaService: TiktokQuotaService,
		private readonly tiktokService: TiktokService
	) { }

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('auth/config')
	getAuthConfig() {
		return {
			statusCode: 200,
			message: 'TikTok auth configuration status fetched successfully',
			data: this.tiktokAuthService.getConfigurationStatus()
		};
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('auth/authorize-url')
	getAuthorizeUrl() {
		// TikTok redirects back to TIKTOK_REDIRECT_URI as a plain browser navigation carrying
		// the `code`, which cannot include this app's bearer token — so there is no
		// authenticated callback route. The admin copies the code AND the state out of the
		// address bar and posts both to auth/exchange below, which verifies the state.
		const state = this.tiktokAuthService.issueState();
		return {
			statusCode: 200,
			message: 'TikTok authorization URL generated successfully',
			data: { authorizeUrl: this.tiktokAuthService.getAuthorizationUrl(state), state }
		};
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('auth/exchange')
	async exchangeAuthorizationCode(@Body('code') code?: string, @Body('state') state?: string) {
		if (!code) {
			throw new BadRequestException('code is required');
		}
		const tokenRow = await this.tiktokAuthService.exchangeAuthorizationCode(code, state);
		return {
			statusCode: 200,
			message: 'TikTok authorization code exchanged successfully',
			data: {
				openId: tokenRow.openId,
				scopes: tokenRow.scopes,
				expiresAt: tokenRow.expiresAt,
				refreshTokenExpiresAt: tokenRow.refreshTokenExpiresAt
			}
		};
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('auth/status')
	async getTokenStatus() {
		return {
			statusCode: 200,
			message: 'TikTok token status fetched successfully',
			data: await this.tiktokAuthService.getTokenStatus()
		};
	}

	/**
	 * Withdraws the app's access and erases the TikTok data derived from it. Both halves are
	 * required by TikTok's Developer Terms — revoking the token while keeping the harvested
	 * analytics would not satisfy it — so this is the one endpoint here that deletes data.
	 */
	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Super_Admin)
	@Post('auth/revoke')
	async revokeAccess(@Body('confirm') confirm?: boolean) {
		if (confirm !== true) {
			throw new BadRequestException(
				'Pass { "confirm": true } to revoke TikTok access. This deletes all stored TikTok profile and video analytics.'
			);
		}
		const revoked = await this.tiktokAuthService.revokeAccess();
		const purged = await this.tiktokService.purgeAllContent();
		return {
			statusCode: 200,
			message: 'TikTok access revoked and stored TikTok data purged',
			data: { ...revoked, ...purged }
		};
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('rate-limits')
	async getRateLimits() {
		return await this.tiktokQuotaService.getStatus();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('account/overview')
	async getAccountOverview() {
		return await this.tiktokService.getAccountOverview();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('videos/statistics')
	async getVideoStats(@Query('maxPages') maxPages?: string) {
		const parsed = Number(maxPages);
		return await this.tiktokService.getVideoStats(
			Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
		);
	}
}
