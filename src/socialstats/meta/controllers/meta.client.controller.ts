import { Public } from '../../../auth';
import { ClientTokenGuard } from '../../../auth/guards/client-token.guard';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { MetaAuthService } from '../services/meta-auth.service';
import { MetaDashboardService } from '../services/meta-dashboard.service';
import { MetaFacebookService } from '../services/meta-facebook.service';
import { MetaGeoService } from '../services/meta-geo.service';
import { MetaIngestService } from '../services/meta-ingest.service';
import { MetaInstagramService } from '../services/meta-instagram.service';
import { MetaRateLimitService } from '../services/meta-rate-limit.service';

@Public()
@UseGuards(ClientTokenGuard)
@Controller('admin/api/client/socialstats/meta')
export class MetaClientController {
	constructor(
		private readonly metaAuthService: MetaAuthService,
		private readonly metaIngestService: MetaIngestService,
		private readonly metaDashboardService: MetaDashboardService,
		private readonly metaFacebookService: MetaFacebookService,
		private readonly metaInstagramService: MetaInstagramService,
		private readonly metaGeoService: MetaGeoService,
		private readonly metaRateLimitService: MetaRateLimitService
	) { }

	@Get('status')
	async getStatus() {
		return await this.metaIngestService.getModuleStatus();
	}

	@Get('auth/config')
	async getAuthConfig() {
		return this.metaAuthService.getConfigurationStatus();
	}

	@Get('rate-limits')
	async getRateLimitStatus() {
		return await this.metaRateLimitService.getStatus();
	}

	@Get('ingest/runs/latest')
	async getLatestRun() {
		return await this.metaIngestService.getLatestRun();
	}

	@Get('facebook/pages')
	async getPages() {
		return await this.metaFacebookService.getPages();
	}

	@Get('facebook/posts')
	async getPosts(@Query('pageId') pageId?: string) {
		return await this.metaFacebookService.getPosts(pageId);
	}

	@Get('dashboard/overview')
	async getDashboardOverview(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('platform') platform?: string
	) {
		return await this.metaDashboardService.getDashboardOverview(
			startDate,
			endDate,
			platform
		);
	}

	@Get('dashboard/content-table')
	async getDashboardContentTable(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('platform') platform?: string,
		@Query('assetType') assetType?: string,
		@Query('sortBy') sortBy?: string,
		@Query('order') order?: 'asc' | 'desc',
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return await this.metaDashboardService.getDashboardContentTable(
			startDate,
			endDate,
			platform,
			assetType,
			sortBy,
			order,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined
		);
	}

	@Get('content/detail')
	async getContentDetail(
		@Query('platform') platform?: string,
		@Query('assetId') assetId?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('metric') metric?: string,
		@Query('geoType') geoType?: string
	) {
		return await this.metaDashboardService.getContentDetail(
			platform,
			assetId,
			startDate,
			endDate,
			metric,
			geoType
		);
	}

	@Get('tags/overall')
	async getOverallTagPerformance(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('platform') platform?: string,
		@Query('sortBy') sortBy?: string,
		@Query('order') order?: 'asc' | 'desc',
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return await this.metaDashboardService.getOverallTagPerformance(
			startDate,
			endDate,
			platform,
			sortBy,
			order,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined
		);
	}

	@Get('tags/detail')
	async getTagDetail(
		@Query('tag') tag?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('platform') platform?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return await this.metaDashboardService.getTagDetail(
			tag,
			startDate,
			endDate,
			platform,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined
		);
	}

	@Get('instagram/profiles')
	async getProfiles() {
		return await this.metaInstagramService.getProfiles();
	}

	@Get('instagram/media')
	async getMedia(@Query('instagramId') instagramId?: string) {
		return await this.metaInstagramService.getMedia(instagramId);
	}

	@Get('instagram/audience-insights/debug')
	async debugAudienceInsights(
		@Query('pageId') pageId?: string,
		@Query('instagramId') instagramId?: string,
		@Query('metric') metric?: string,
		@Query('breakdown') breakdown?: string,
		@Query('timeframe') timeframe?: string
	) {
		return await this.metaInstagramService.debugAudienceInsights({
			pageId,
			instagramId,
			metric,
			breakdown,
			timeframe
		});
	}

	@Get('videos/geo/hotspot')
	async getVideoGeoHotspot(
		@Query('platform') platform?: string,
		@Query('assetId') assetId?: string,
		@Query('metric') metric?: string,
		@Query('geoType') geoType?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.metaGeoService.getVideoHotspot({
			platform,
			assetId,
			metric,
			geoType,
			startDate,
			endDate
		});
	}

	@Get('videos/geo/table')
	async getVideoGeoTable(
		@Query('platform') platform?: string,
		@Query('assetId') assetId?: string,
		@Query('metric') metric?: string,
		@Query('geoType') geoType?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.metaGeoService.getVideoGeoTable({
			platform,
			assetId,
			metric,
			geoType,
			startDate,
			endDate
		});
	}

	@Get('breakdown/geo')
	async getGeoBreakdown(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('platform') platform?: string,
		@Query('geoType') geoType?: string,
		@Query('metric') metric?: string
	) {
		return await this.metaDashboardService.getGeoBreakdown(
			startDate,
			endDate,
			platform,
			geoType,
			metric
		);
	}
}
