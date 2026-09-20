import { AuthModuleModule } from '../auth';
import { Module } from '@nestjs/common';
import { LinkedinModule } from './linkedin/linkedin.module';
import { MetaModule } from './meta/meta.module';
import { SocialStatsSharedModule } from './shared/socialstats-shared.module';
import { SocialStatsIngestionController } from './socialstats-ingestion.controller';
import { TiktokModule } from './tiktok/tiktok.module';
import { YoutubeModule } from './youtube/youtube.module';

@Module({
	imports: [YoutubeModule, MetaModule, LinkedinModule, TiktokModule, SocialStatsSharedModule, AuthModuleModule],
	controllers: [SocialStatsIngestionController]
})
export class SocialStatsModule { }
