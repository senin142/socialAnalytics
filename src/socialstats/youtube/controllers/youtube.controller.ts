import { JwtAuthGuard, Roles } from '../../../auth';
import { RoleTypes } from '../../../enums';
import {
	BadRequestException,
	Controller,
	Get,
	Post,
	Query,
	UseGuards
} from '@nestjs/common';
import { YoutubeQuotaService } from '../services/youtube-quota.service';
import { YoutubeReachService } from '../services/youtube-reach.service';
import { YoutubeService } from '../services/youtube.service';

@Controller('admin/api/admin/socialstats/youtube')
export class YoutubeController {
	constructor(
		private youtubeService: YoutubeService,
		private youtubeQuotaService: YoutubeQuotaService,
		private youtubeReachService: YoutubeReachService
	) { }

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('channel-stats/live')
	async getChannelStats() {
		return await this.youtubeService.getChannelStats();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('auth/debug')
	async getAuthDebugInfo() {
		return await this.youtubeService.getAuthDebugInfo();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('channel-stats/latest')
	async getLatestIngestedStats() {
		return await this.youtubeService.getLatestIngestedStats();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('live-stream/current')
	async getCurrentLiveStreamStats() {
		return await this.youtubeService.getCurrentLiveStreamStats();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('live-stream/dashboard')
	async getLiveDashboard(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.getLiveDashboard(startDate, endDate);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('channel-stats/ingest')
	async ingestYoutubeStats() {
		return await this.youtubeService.ingestChannelStats();
	}

	/**
	 * Manual trigger for the bulk reach-report sync that otherwise only runs on the
	 * 03:30 UTC cron. No payload: it resumes from each report type's own cursor
	 * (youtubeReportingJobStateRepo), so it naturally backfills anything a prior
	 * failed run left unprocessed.
	 */
	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('reach-reports/ingest')
	async ingestReachReports() {
		return await this.youtubeReachService.syncNewReports();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('analytics/timeseries')
	async getAnalyticsTimeseries(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return await this.youtubeService.getAnalyticsTimeseries(
			startDate,
			endDate,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('traffic-sources')
	async getTrafficSources(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return await this.youtubeService.getTrafficSources(
			startDate,
			endDate,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('traffic-sources/detail')
	async getTrafficSourceDetail(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return await this.youtubeService.getTrafficSourceDetail(
			startDate,
			endDate,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('audience/demographics')
	async getAudienceDemographics(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.getAudienceDemographics(startDate, endDate);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('analytics/content-type')
	async getContentTypeBreakdown(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.getContentTypeBreakdown(startDate, endDate);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('analytics/live-vs-on-demand')
	async getLiveVsOnDemand(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.getLiveVsOnDemand(startDate, endDate);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('analytics/viewer-segments')
	async getViewerSegments(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.getViewerSegments(startDate, endDate);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('analytics/monetization')
	async getMonetization(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.getMonetization(startDate, endDate);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('videos/impressions-ctr')
	async getImpressionsAndCtr(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('maxResults') maxResults?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return await this.youtubeService.getImpressionsAndCtr(
			startDate,
			endDate,
			maxResults ? Number(maxResults) : undefined,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('analytics/bulk-video-daily')
	async getBulkVideoDailyStats(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('maxResults') maxResults?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return await this.youtubeService.getBulkVideoDailyStats(
			startDate,
			endDate,
			maxResults ? Number(maxResults) : undefined,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('analytics/bulk-traffic-sources')
	async getBulkTrafficSourceStats(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('maxResults') maxResults?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return await this.youtubeService.getBulkTrafficSourceStats(
			startDate,
			endDate,
			maxResults ? Number(maxResults) : undefined,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('quota/status')
	async getQuotaStatus() {
		return await this.youtubeQuotaService.getStatus();
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('videos/top')
	async getTopVideos(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('maxResults') maxResults?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return await this.youtubeService.getTopVideos(
			startDate,
			endDate,
			maxResults ? Number(maxResults) : undefined,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('tags/overall')
	async getOverallTagPerformance(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('maxResults') maxResults?: string,
		@Query('sortBy') sortBy?: string,
		@Query('order') order?: 'asc' | 'desc',
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return await this.youtubeService.getOverallTagPerformance(
			startDate,
			endDate,
			maxResults ? Number(maxResults) : undefined,
			sortBy,
			order,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('tags/country')
	async getCountryTagPerformance(
		@Query('channelId') channelId?: string,
		@Query('countryCode') countryCode?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('sortBy') sortBy?: string,
		@Query('order') order?: 'asc' | 'desc',
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		if (!channelId || !countryCode) {
			throw new BadRequestException('channelId and countryCode are required');
		}

		return await this.youtubeService.getCountryTagPerformance(
			channelId,
			countryCode,
			startDate,
			endDate,
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
		@Query('maxResults') maxResults?: string,
		@Query('channelId') channelId?: string,
		@Query('countryCode') countryCode?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		if (!tag) {
			throw new BadRequestException('tag is required');
		}

		return await this.youtubeService.getTagDetail(
			tag,
			startDate,
			endDate,
			maxResults ? Number(maxResults) : undefined,
			channelId,
			countryCode,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('dashboard/overview')
	async getDashboardOverview(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('metricSet') metricSet?: string,
		@Query('timezone') timezone?: string
	) {
		return await this.youtubeService.getDashboardOverview(
			startDate,
			endDate,
			metricSet,
			timezone
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('dashboard/content-table')
	async getDashboardContentTable(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('sortBy') sortBy?: string,
		@Query('order') order?: 'asc' | 'desc',
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('maxResults') maxResults?: string
	) {
		return await this.youtubeService.getDashboardContentTable(
			startDate,
			endDate,
			sortBy,
			order,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined,
			maxResults ? Number(maxResults) : undefined
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('retention/video')
	async getVideoRetention(
		@Query('channelId') channelId?: string,
		@Query('videoId') videoId?: string
	) {
		if (!channelId || !videoId) {
			throw new BadRequestException('channelId and videoId are required');
		}

		return await this.youtubeService.getVideoRetention(channelId, videoId);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('live-stream/viewer-timeline')
	async getLiveViewerTimeline(
		@Query('channelId') channelId?: string,
		@Query('videoId') videoId?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		if (!channelId || !videoId) {
			throw new BadRequestException('channelId and videoId are required');
		}

		return await this.youtubeService.getLiveViewerTimeline(
			channelId,
			videoId,
			startDate,
			endDate
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('videos/summary')
	async getVideoAnalyticsSummary(
		@Query('channelId') channelId?: string,
		@Query('videoId') videoId?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		if (!channelId || !videoId) {
			throw new BadRequestException('channelId and videoId are required');
		}

		return await this.youtubeService.getVideoAnalyticsSummary(
			channelId,
			videoId,
			startDate,
			endDate
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('retention/top-tracked')
	async getTopTrackedVideoRetention(@Query('topN') topN?: string) {
		return await this.youtubeService.getTopTrackedVideoRetention(
			topN ? Number(topN) : undefined
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('breakdown/geo')
	async getGeoBreakdown(
		@Query('channelId') channelId?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		if (!channelId) {
			throw new BadRequestException('channelId is required');
		}

		return await this.youtubeService.getGeoBreakdown(channelId, startDate, endDate);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('breakdown/geo/hotspot')
	async getGeoHotspot(
		@Query('channelId') channelId?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('metric') metric?: string
	) {
		if (!channelId) {
			throw new BadRequestException('channelId is required');
		}

		return await this.youtubeService.getGeoHotspot(
			channelId,
			startDate,
			endDate,
			metric
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('breakdown/geo/country-videos')
	async getGeoCountryVideos(
		@Query('channelId') channelId?: string,
		@Query('countryCode') countryCode?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('sortBy') sortBy?: string,
		@Query('order') order?: 'asc' | 'desc',
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		if (!channelId || !countryCode) {
			throw new BadRequestException('channelId and countryCode are required');
		}

		return await this.youtubeService.getGeoCountryVideos(
			channelId,
			countryCode,
			startDate,
			endDate,
			sortBy,
			order,
			page ? Number(page) : undefined,
			limit ? Number(limit) : undefined
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('breakdown/geo/video-countries')
	async getVideoGeoBreakdown(
		@Query('channelId') channelId?: string,
		@Query('videoId') videoId?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string,
		@Query('metric') metric?: string
	) {
		if (!channelId || !videoId) {
			throw new BadRequestException('channelId and videoId are required');
		}

		return await this.youtubeService.getVideoGeoBreakdown(
			channelId,
			videoId,
			startDate,
			endDate,
			metric
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Get('breakdown/device')
	async getDeviceBreakdown(
		@Query('channelId') channelId?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		if (!channelId) {
			throw new BadRequestException('channelId is required');
		}

		return await this.youtubeService.getDeviceBreakdown(
			channelId,
			startDate,
			endDate
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('retention/ingest-daily')
	async ingestDailyRetention(
		@Query('topN') topN?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.ingestDailyVideoRetentionStats(
			topN ? Number(topN) : undefined,
			startDate,
			endDate
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('breakdown/ingest-daily')
	async ingestDailyGeoDevice(
		@Query('date') date?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.ingestDailyGeoDeviceStats(
			date,
			startDate,
			endDate
		);
	}

	@UseGuards(JwtAuthGuard)
	@Roles(RoleTypes.Admin, RoleTypes.Super_Admin, RoleTypes.Analytics_Admin)
	@Post('breakdown/geo-videos/ingest-daily')
	async ingestDailyVideoGeo(
		@Query('topN') topN?: string,
		@Query('date') date?: string,
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.ingestDailyVideoGeoStats(
			topN ? Number(topN) : undefined,
			date,
			startDate,
			endDate
		);
	}
}
