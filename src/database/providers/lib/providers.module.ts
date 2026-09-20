import { Module } from '@nestjs/common';
import { CityListProvider } from '../providers/city.list.provider';
import { CountryListProvider } from '../providers/country.list.provider';
import { IngestionRunsProvider } from '../providers/ingestion.runs.provider';
import { LinkedinAccountTokensProvider } from '../providers/linkedin.account.tokens.provider';
import { LinkedinApiUsageProvider } from '../providers/linkedin.api.usage.provider';
import { LinkedinFollowerStatsProvider } from '../providers/linkedin.follower.stats.provider';
import { LinkedinOrganizationStatsProvider } from '../providers/linkedin.organization.stats.provider';
import { LinkedinPageStatsProvider } from '../providers/linkedin.page.stats.provider';
import { LinkedinShareStatsProvider } from '../providers/linkedin.share.stats.provider';
import { MetaAccountTokensProvider } from '../providers/meta.account.tokens.provider';
import { MetaAudienceDemographicStatsProvider } from '../providers/meta.audience.demographic.stats.provider';
import { MetaAudienceGeoStatsProvider } from '../providers/meta.audience.geo.stats.provider';
import { MetaBackfillWalkStateProvider } from '../providers/meta.backfill.walk.state.provider';
import { MetaContentMetricSnapshotsProvider } from '../providers/meta.content.metric.snapshots.provider';
import { MetaFacebookPageInsightsProvider } from '../providers/meta.facebook.page.insights.provider';
import { MetaFacebookPagesProvider } from '../providers/meta.facebook.pages.provider';
import { MetaFacebookPostsProvider } from '../providers/meta.facebook.posts.provider';
import { MetaFacebookVideoMetricsProvider } from '../providers/meta.facebook.video.metrics.provider';
import { MetaGeoLocationsProvider } from '../providers/meta.geo.locations.provider';
import { MetaIngestionRunsProvider } from '../providers/meta.ingestion.runs.provider';
import { MetaInstagramAccountInsightsProvider } from '../providers/meta.instagram.account.insights.provider';
import { MetaInstagramMediaInsightsProvider } from '../providers/meta.instagram.media.insights.provider';
import { MetaInstagramMediaProvider } from '../providers/meta.instagram.media.provider';
import { MetaInstagramProfilesProvider } from '../providers/meta.instagram.profiles.provider';
import { MetaInstagramStoryStatsProvider } from '../providers/meta.instagram.story.stats.provider';
import { MetaRateLimitEventsProvider } from '../providers/meta.rate.limit.events.provider';
import { MetaVideoGeoStatsProvider } from '../providers/meta.video.geo.stats.provider';
import { SocialStatsDataCoverageProvider } from '../providers/social.stats.data.coverage.provider';
import { SocialStatsIngestionControlProvider } from '../providers/social.stats.ingestion.control.provider';
import { TiktokAccountStatsProvider } from '../providers/tiktok.account.stats.provider';
import { TiktokAccountTokensProvider } from '../providers/tiktok.account.tokens.provider';
import { TiktokApiUsageProvider } from '../providers/tiktok.api.usage.provider';
import { TiktokVideoStatsProvider } from '../providers/tiktok.video.stats.provider';
import { YoutubeAnalyticsSnapshotsProvider } from '../providers/youtube.analytics.snapshots.provider';
import { YoutubeChannelStatsProvider } from '../providers/youtube.channel.stats.provider';
import { YoutubeGeoDeviceStatsProvider } from '../providers/youtube.geo.device.stats.provider';
import { YoutubeLiveViewerStatsProvider } from '../providers/youtube.live.viewer.stats.provider';
import { YoutubeQuotaUsageProvider } from '../providers/youtube.quota.usage.provider';
import { YoutubeReachStatsProvider } from '../providers/youtube.reach.stats.provider';
import { YoutubeReportingJobStateProvider } from '../providers/youtube.reporting.job.state.provider';
import { YoutubeVideoDailyStatsProvider } from '../providers/youtube.video.daily.stats.provider';
import { YoutubeVideoGeoStatsProvider } from '../providers/youtube.video.geo.stats.provider';
import { YoutubeVideoRetentionStatsProvider } from '../providers/youtube.video.retention.stats.provider';
import { YoutubeVideoTrafficSourceStatsProvider } from '../providers/youtube.video.traffic.source.stats.provider';

@Module({
	providers: [
		...CityListProvider,
		...CountryListProvider,
		...IngestionRunsProvider,
		...LinkedinAccountTokensProvider,
		...LinkedinApiUsageProvider,
		...LinkedinFollowerStatsProvider,
		...LinkedinOrganizationStatsProvider,
		...LinkedinPageStatsProvider,
		...LinkedinShareStatsProvider,
		...MetaAccountTokensProvider,
		...MetaAudienceDemographicStatsProvider,
		...MetaAudienceGeoStatsProvider,
		...MetaBackfillWalkStateProvider,
		...MetaContentMetricSnapshotsProvider,
		...MetaFacebookPageInsightsProvider,
		...MetaFacebookPagesProvider,
		...MetaFacebookPostsProvider,
		...MetaFacebookVideoMetricsProvider,
		...MetaGeoLocationsProvider,
		...MetaIngestionRunsProvider,
		...MetaInstagramAccountInsightsProvider,
		...MetaInstagramMediaInsightsProvider,
		...MetaInstagramMediaProvider,
		...MetaInstagramProfilesProvider,
		...MetaInstagramStoryStatsProvider,
		...MetaRateLimitEventsProvider,
		...MetaVideoGeoStatsProvider,
		...SocialStatsDataCoverageProvider,
		...SocialStatsIngestionControlProvider,
		...TiktokAccountStatsProvider,
		...TiktokAccountTokensProvider,
		...TiktokApiUsageProvider,
		...TiktokVideoStatsProvider,
		...YoutubeAnalyticsSnapshotsProvider,
		...YoutubeChannelStatsProvider,
		...YoutubeGeoDeviceStatsProvider,
		...YoutubeLiveViewerStatsProvider,
		...YoutubeQuotaUsageProvider,
		...YoutubeReachStatsProvider,
		...YoutubeReportingJobStateProvider,
		...YoutubeVideoDailyStatsProvider,
		...YoutubeVideoGeoStatsProvider,
		...YoutubeVideoRetentionStatsProvider,
		...YoutubeVideoTrafficSourceStatsProvider,
	],
	exports: [
		...CityListProvider,
		...CountryListProvider,
		...IngestionRunsProvider,
		...LinkedinAccountTokensProvider,
		...LinkedinApiUsageProvider,
		...LinkedinFollowerStatsProvider,
		...LinkedinOrganizationStatsProvider,
		...LinkedinPageStatsProvider,
		...LinkedinShareStatsProvider,
		...MetaAccountTokensProvider,
		...MetaAudienceDemographicStatsProvider,
		...MetaAudienceGeoStatsProvider,
		...MetaBackfillWalkStateProvider,
		...MetaContentMetricSnapshotsProvider,
		...MetaFacebookPageInsightsProvider,
		...MetaFacebookPagesProvider,
		...MetaFacebookPostsProvider,
		...MetaFacebookVideoMetricsProvider,
		...MetaGeoLocationsProvider,
		...MetaIngestionRunsProvider,
		...MetaInstagramAccountInsightsProvider,
		...MetaInstagramMediaInsightsProvider,
		...MetaInstagramMediaProvider,
		...MetaInstagramProfilesProvider,
		...MetaInstagramStoryStatsProvider,
		...MetaRateLimitEventsProvider,
		...MetaVideoGeoStatsProvider,
		...SocialStatsDataCoverageProvider,
		...SocialStatsIngestionControlProvider,
		...TiktokAccountStatsProvider,
		...TiktokAccountTokensProvider,
		...TiktokApiUsageProvider,
		...TiktokVideoStatsProvider,
		...YoutubeAnalyticsSnapshotsProvider,
		...YoutubeChannelStatsProvider,
		...YoutubeGeoDeviceStatsProvider,
		...YoutubeLiveViewerStatsProvider,
		...YoutubeQuotaUsageProvider,
		...YoutubeReachStatsProvider,
		...YoutubeReportingJobStateProvider,
		...YoutubeVideoDailyStatsProvider,
		...YoutubeVideoGeoStatsProvider,
		...YoutubeVideoRetentionStatsProvider,
		...YoutubeVideoTrafficSourceStatsProvider,
	],
})
export class ProvidersModule {}
