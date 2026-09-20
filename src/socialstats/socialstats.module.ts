import { AuthModuleModule } from '../auth';
import { Module } from '@nestjs/common';
// import { LinkedinModule } from './linkedin/linkedin.module';
import { MetaModule } from './meta/meta.module';
import { SocialStatsSharedModule } from './shared/socialstats-shared.module';
import { SocialStatsIngestionController } from './socialstats-ingestion.controller';
// import { TiktokModule } from './tiktok/tiktok.module';
import { YoutubeModule } from './youtube/youtube.module';

// LinkedIn and TikTok are ported but left unwired until Meta + YouTube boot
// cleanly end-to-end (staged rollout per SOCIAL_ANALYTICS_BACKEND_REQUIREMENTS.txt section 7).
@Module({
	imports: [YoutubeModule, MetaModule, SocialStatsSharedModule, AuthModuleModule],
	controllers: [SocialStatsIngestionController]
})
export class SocialStatsModule { }
