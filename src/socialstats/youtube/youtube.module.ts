import { AuthModuleModule } from '../../auth';
import { ClientTokenGuard } from '../../auth/guards/client-token.guard';
import { ProvidersModule } from '../../database/providers';
import { Module } from '@nestjs/common';
import { SocialStatsSharedModule } from '../shared/socialstats-shared.module';
import { YoutubeClientController } from './controllers/youtube.client.controller';
import { YoutubeController } from './controllers/youtube.controller';
import { YoutubeAuthService } from './services/youtube-auth.service';
import { YoutubeIngestService } from './services/youtube-ingest.service';
import { YoutubeQuotaService } from './services/youtube-quota.service';
import { YoutubeReachService } from './services/youtube-reach.service';
import { YoutubeService } from './services/youtube.service';

@Module({
	imports: [ProvidersModule, AuthModuleModule, SocialStatsSharedModule],
	controllers: [YoutubeController, YoutubeClientController],
	providers: [YoutubeAuthService, YoutubeService, YoutubeIngestService, YoutubeQuotaService, YoutubeReachService, ClientTokenGuard]
})
export class YoutubeModule { }
