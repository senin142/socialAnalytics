import { JwtAuthGuard, Roles } from '../auth';
import { RoleTypes } from '../enums';
import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IngestionControlService } from './shared/services/ingestion-control.service';
import { IngestionStatusService } from './shared/services/ingestion-status.service';

const VALID_PLATFORMS = new Set(['meta', 'youtube', 'linkedin']);

@Controller('admin/api/admin/socialstats/ingestion')
export class SocialStatsIngestionController {
	constructor(
		private readonly ingestionStatusService: IngestionStatusService,
		private readonly ingestionControlService: IngestionControlService
	) { }

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('status')
	async getStatus(@Query('platform') platform?: string) {
		return await this.ingestionStatusService.getStatus(platform);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('runs')
	async getRuns(
		@Query('platform') platform?: string,
		@Query('status') status?: string,
		@Query('limit') limit?: string
	) {
		return await this.ingestionStatusService.getRuns({
			platform,
			status,
			limit: limit ? Number(limit) : undefined
		});
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('pause')
	async pauseIngestion(
		@Req() req,
		@Body('platform') platform?: string,
		@Body('jobType') jobType?: string,
		@Body('reason') reason?: string
	) {
		if (!platform || !VALID_PLATFORMS.has(platform)) {
			throw new BadRequestException('platform is required and must be "meta", "youtube" or "linkedin"');
		}

		const control = await this.ingestionControlService.pause({
			platform,
			jobType: jobType || undefined,
			reason,
			pausedBy: req?.user?.data?.id ? String(req.user.data.id) : undefined
		});

		return {
			statusCode: 200,
			message: jobType
				? `Paused ${platform} ${jobType} ingestion`
				: `Paused all ${platform} ingestion`,
			data: control
		};
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('resume')
	async resumeIngestion(
		@Body('platform') platform?: string,
		@Body('jobType') jobType?: string
	) {
		if (!platform || !VALID_PLATFORMS.has(platform)) {
			throw new BadRequestException('platform is required and must be "meta", "youtube" or "linkedin"');
		}

		const control = await this.ingestionControlService.resume({
			platform,
			jobType: jobType || undefined
		});

		return {
			statusCode: 200,
			message: jobType
				? `Resumed ${platform} ${jobType} ingestion`
				: `Resumed all ${platform} ingestion`,
			data: control
		};
	}
}
