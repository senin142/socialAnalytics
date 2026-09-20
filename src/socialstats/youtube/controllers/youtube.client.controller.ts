import { Public } from '../../../auth';
import { ClientTokenGuard } from '../../../auth/guards/client-token.guard';
import { BadRequestException, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { YoutubeQuotaService } from '../services/youtube-quota.service';
import { YoutubeService } from '../services/youtube.service';

@Public()
@UseGuards(ClientTokenGuard)
@Controller('admin/api/client/socialstats/youtube')
export class YoutubeClientController {
	constructor(
		private youtubeService: YoutubeService,
		private youtubeQuotaService: YoutubeQuotaService
	) { }

	@Get('channel-stats/live')
	async getChannelStats() {
		return await this.youtubeService.getChannelStats();
	}

	@Get('auth/debug')
	async getAuthDebugInfo() {
		return await this.youtubeService.getAuthDebugInfo();
	}

	@Get('channel-stats/latest')
	async getLatestIngestedStats() {
		return await this.youtubeService.getLatestIngestedStats();
	}

	@Get('live-stream/current')
	async getCurrentLiveStreamStats() {
		return await this.youtubeService.getCurrentLiveStreamStats();
	}

	@Get('live-stream/dashboard')
	async getLiveDashboard(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.getLiveDashboard(startDate, endDate);
	}

	@Post('channel-stats/ingest')
	async ingestYoutubeStats() {
		return await this.youtubeService.ingestChannelStats();
	}

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

	@Get('audience/demographics')
	async getAudienceDemographics(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.getAudienceDemographics(startDate, endDate);
	}

	@Get('analytics/content-type')
	async getContentTypeBreakdown(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.getContentTypeBreakdown(startDate, endDate);
	}

	@Get('analytics/live-vs-on-demand')
	async getLiveVsOnDemand(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.getLiveVsOnDemand(startDate, endDate);
	}

	@Get('analytics/viewer-segments')
	async getViewerSegments(
		@Query('startDate') startDate?: string,
		@Query('endDate') endDate?: string
	) {
		return await this.youtubeService.getViewerSegments(startDate, endDate);
	}

	// Monetization is deliberately admin-only: revenue figures do not belong on the
	// unauthenticated client surface.

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

	@Get('quota/status')
	async getQuotaStatus() {
		return await this.youtubeQuotaService.getStatus();
	}

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

	@Get('retention/top-tracked')
	async getTopTrackedVideoRetention(@Query('topN') topN?: string) {
		return await this.youtubeService.getTopTrackedVideoRetention(
			topN ? Number(topN) : undefined
		);
	}

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
