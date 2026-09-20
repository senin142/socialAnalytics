import { JwtAuthGuard, Roles } from '../../../auth';
import { RoleTypes } from '../../../enums';
import {
	Body,
	Controller,
	Get,
	Post,
	Query,
	UseGuards
} from '@nestjs/common';
import { MetaAuthService } from '../services/meta-auth.service';
import { MetaBackfillWalkService } from '../services/meta-backfill-walk.service';
import { MetaDashboardService } from '../services/meta-dashboard.service';
import { MetaFacebookService } from '../services/meta-facebook.service';
import { MetaGeoService } from '../services/meta-geo.service';
import { MetaIngestService } from '../services/meta-ingest.service';
import { MetaInstagramService } from '../services/meta-instagram.service';
import { MetaRateLimitService } from '../services/meta-rate-limit.service';

@Controller('admin/api/admin/socialstats/meta')
export class MetaController {
	constructor(
		private readonly metaAuthService: MetaAuthService,
		private readonly metaRateLimitService: MetaRateLimitService,
		private readonly metaIngestService: MetaIngestService,
		private readonly metaDashboardService: MetaDashboardService,
		private readonly metaFacebookService: MetaFacebookService,
		private readonly metaInstagramService: MetaInstagramService,
		private readonly metaGeoService: MetaGeoService,
		private readonly metaBackfillWalkService: MetaBackfillWalkService
	) { }

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('status')
	async getStatus() {
		return await this.metaIngestService.getModuleStatus();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('auth/config')
	async getAuthConfig() {
		return this.metaAuthService.getConfigurationStatus();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('auth/exchange-user-token')
	async exchangeUserToken(@Body('shortLivedUserToken') shortLivedUserToken?: string) {
		return await this.metaAuthService.exchangeUserToken(shortLivedUserToken || '');
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('auth/bootstrap')
	async bootstrapManagedAssets(
		@Body('shortLivedUserToken') shortLivedUserToken?: string,
		@Body('pageId') pageId?: string
	) {
		return await this.metaAuthService.bootstrapManagedAssets({
			shortLivedUserToken,
			pageId
		});
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('rate-limits')
	async getRateLimitStatus() {
		return await this.metaRateLimitService.getStatus();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('ingest/runs/latest')
	async getLatestRun() {
		return await this.metaIngestService.getLatestRun();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
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

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
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

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
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

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
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

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
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

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('ingest/profile-snapshot')
	async ingestProfileSnapshot(
		@Body('pageId') pageId?: string,
		@Body('shortLivedUserToken') shortLivedUserToken?: string
	) {
		return await this.metaIngestService.ingestProfileSnapshot({
			pageId,
			shortLivedUserToken
		});
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('ingest/profile-snapshot/refresh')
	async refreshProfileSnapshot(
		@Body('pageId') pageId?: string,
		@Body('force') force?: boolean,
		@Body('minFreshMinutes') minFreshMinutes?: number | string
	) {
		const parsedMinFreshMinutes =
			typeof minFreshMinutes === 'number'
				? minFreshMinutes
				: typeof minFreshMinutes === 'string'
					? Number(minFreshMinutes)
					: undefined;

		return await this.metaIngestService.requestProfileSnapshotRefresh({
			pageId,
			force,
			minFreshMinutes:
				parsedMinFreshMinutes !== undefined && Number.isFinite(parsedMinFreshMinutes)
					? parsedMinFreshMinutes
					: undefined
		});
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('ingest/profile-snapshot/backfill')
	async backfillProfileSnapshot(
		@Body('pageId') pageId?: string,
		@Body('startDate') startDate?: string,
		@Body('endDate') endDate?: string
	) {
		return await this.metaIngestService.backfillProfileSnapshot({
			pageId,
			startDate,
			endDate
		});
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('ingest/content-snapshot')
	async queueContentSnapshot(@Body() body: Record<string, unknown>) {
		const facebookPostLimit =
			typeof body.facebookPostLimit === 'number'
				? body.facebookPostLimit
				: typeof body.facebookPostLimit === 'string'
					? Number(body.facebookPostLimit)
					: undefined;
		const instagramMediaLimit =
			typeof body.instagramMediaLimit === 'number'
				? body.instagramMediaLimit
				: typeof body.instagramMediaLimit === 'string'
					? Number(body.instagramMediaLimit)
					: undefined;

		return await this.metaIngestService.ingestContentSnapshot({
			pageId: typeof body.pageId === 'string' ? body.pageId : undefined,
			instagramId: typeof body.instagramId === 'string' ? body.instagramId : undefined,
			from: typeof body.from === 'string' ? body.from : undefined,
			to: typeof body.to === 'string' ? body.to : undefined,
			includePosts: typeof body.includePosts === 'boolean' ? body.includePosts : undefined,
			includeMedia: typeof body.includeMedia === 'boolean' ? body.includeMedia : undefined,
			facebookPostLimit:
				facebookPostLimit !== undefined && Number.isFinite(facebookPostLimit)
					? Math.max(0, Math.floor(facebookPostLimit))
					: undefined,
			instagramMediaLimit:
				instagramMediaLimit !== undefined && Number.isFinite(instagramMediaLimit)
					? Math.max(0, Math.floor(instagramMediaLimit))
					: undefined
		});
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('ingest/geo-snapshot')
	async queueGeoSnapshot(@Body() body: Record<string, unknown>) {
		return await this.metaIngestService.ingestGeoSnapshot({
			pageId: typeof body.pageId === 'string' ? body.pageId : undefined,
			instagramId: typeof body.instagramId === 'string' ? body.instagramId : undefined,
			startDate: typeof body.startDate === 'string' ? body.startDate : undefined,
			endDate: typeof body.endDate === 'string' ? body.endDate : undefined
		});
	}

	/**
	 * Starts an in-process background walk that steps a fixed-size date window backward,
	 * one chunk per tick, calling profile-snapshot/content-snapshot/geo-snapshot backfill for
	 * each window until `deadline`. Returns immediately; progress is polled via
	 * backfill-walk/status. See MetaBackfillWalkService for retry/skip semantics.
	 */
	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('ingest/backfill-walk/start')
	async startBackfillWalk(@Body() body: Record<string, unknown>) {
		return await this.metaBackfillWalkService.start({
			pageId: typeof body.pageId === 'string' ? body.pageId : undefined,
			instagramId: typeof body.instagramId === 'string' ? body.instagramId : undefined,
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
		return this.metaBackfillWalkService.getStatus();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('ingest/backfill-walk/stop')
	async stopBackfillWalk() {
		return await this.metaBackfillWalkService.stop();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('ingest/story-snapshot')
	async queueStorySnapshot(@Body() body: Record<string, unknown>) {
		return await this.metaIngestService.ingestStorySnapshot({
			pageId: typeof body.pageId === 'string' ? body.pageId : undefined,
			instagramId: typeof body.instagramId === 'string' ? body.instagramId : undefined
		});
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('facebook/pages')
	async getPages() {
		return await this.metaFacebookService.getPages();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('facebook/posts')
	async getPosts(@Query('pageId') pageId?: string) {
		return await this.metaFacebookService.getPosts(pageId);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('instagram/profiles')
	async getProfiles() {
		return await this.metaInstagramService.getProfiles();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('instagram/media')
	async getMedia(@Query('instagramId') instagramId?: string) {
		return await this.metaInstagramService.getMedia(instagramId);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
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

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
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

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
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

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
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

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('facebook/page-insights')
	async getFacebookPageInsightsTrends(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.metaDashboardService.getFacebookPageInsightsTrends(
			startDate,
			endDate
		);
	}
}
