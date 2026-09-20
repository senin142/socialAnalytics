import { JwtAuthGuard, Roles } from '../../../auth';
import { RoleTypes } from '../../../enums';
import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { LinkedinAuthService } from '../services/linkedin-auth.service';
import { LinkedinBackfillWalkService } from '../services/linkedin-backfill-walk.service';
import { LinkedinQuotaService } from '../services/linkedin-quota.service';
import { LinkedinService } from '../services/linkedin.service';

@Controller('admin/api/admin/socialstats/linkedin')
export class LinkedinController {
	constructor(
		private readonly linkedinAuthService: LinkedinAuthService,
		private readonly linkedinQuotaService: LinkedinQuotaService,
		private readonly linkedinService: LinkedinService,
		private readonly linkedinBackfillWalkService: LinkedinBackfillWalkService
	) { }

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('auth/config')
	getAuthConfig() {
		return {
			statusCode: 200,
			message: 'LinkedIn auth configuration status fetched successfully',
			data: this.linkedinAuthService.getConfigurationStatus()
		};
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('auth/verify')
	async verifyCredentials() {
		return {
			statusCode: 200,
			message: 'LinkedIn credential verification completed',
			data: await this.linkedinService.verifyCredentials()
		};
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('auth/authorize-url')
	getAuthorizeUrl() {
		// LinkedIn's redirect back to LINKEDIN_REDIRECT_URI carries the `code` as a query
		// param on a plain browser navigation — it can't include our app's bearer token, so
		// there's no authenticated callback route here. Instead the admin who just completed
		// LinkedIn's consent screen copies that `code` and `state` out of the address bar and
		// pastes both into POST auth/exchange below, which verifies the state.
		const state = this.linkedinAuthService.issueState();
		return {
			statusCode: 200,
			message: 'LinkedIn authorization URL generated successfully',
			data: { authorizeUrl: this.linkedinAuthService.getAuthorizationUrl(state), state }
		};
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('auth/exchange')
	async exchangeAuthorizationCode(@Body('code') code?: string, @Body('state') state?: string) {
		if (!code) {
			throw new BadRequestException('code is required');
		}
		const tokenRow = await this.linkedinAuthService.exchangeAuthorizationCode(code, state);
		return {
			statusCode: 200,
			message: 'LinkedIn authorization code exchanged successfully',
			data: {
				organizationUrn: tokenRow.organizationUrn,
				expiresAt: tokenRow.expiresAt,
				scopes: tokenRow.scopes
			}
		};
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('rate-limits')
	async getRateLimits() {
		return await this.linkedinQuotaService.getStatus();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('organization/overview')
	async getOrganizationOverview() {
		return await this.linkedinService.getOrganizationOverview();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('followers/statistics')
	async getFollowerStatistics() {
		return await this.linkedinService.getFollowerStatistics();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('page/statistics')
	async getPageStatistics(@Query('startDate') startDate?: string, @Query('endDate') endDate?: string) {
		return await this.linkedinService.getPageStatistics(startDate, endDate);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('shares/statistics')
	async getShareStatistics(@Query('startDate') startDate?: string, @Query('endDate') endDate?: string) {
		return await this.linkedinService.getShareStatistics(startDate, endDate);
	}

	/**
	 * Starts an in-process background walk that steps a fixed-size date window backward,
	 * one chunk per tick, backfilling page statistics and (while within its 12-month window)
	 * share statistics for each window until `deadline`. Returns immediately; progress is
	 * polled via backfill-walk/status. Follower statistics and organization overview are not
	 * backfillable -- LinkedIn only exposes those as lifetime aggregates. See
	 * LinkedinBackfillWalkService for the 12-month floor and retry semantics.
	 */
	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('ingest/backfill-walk/start')
	async startBackfillWalk(@Body() body: Record<string, unknown>) {
		return await this.linkedinBackfillWalkService.start({
			chunkDays: typeof body.chunkDays === 'number' ? body.chunkDays : undefined,
			intervalMinutes: typeof body.intervalMinutes === 'number' ? body.intervalMinutes : undefined,
			deadline: typeof body.deadline === 'string' ? body.deadline : undefined,
			startDate: typeof body.startDate === 'string' ? body.startDate : undefined
		});
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('ingest/backfill-walk/status')
	getBackfillWalkStatus() {
		return this.linkedinBackfillWalkService.getStatus();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('ingest/backfill-walk/stop')
	async stopBackfillWalk() {
		return await this.linkedinBackfillWalkService.stop();
	}
}
