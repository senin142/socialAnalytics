import { AuthModuleModule } from '../../auth';
import { ProvidersModule } from '../../database/providers';
import { Module } from '@nestjs/common';
import { SocialStatsSharedModule } from '../shared/socialstats-shared.module';
import { TiktokController } from './controllers/tiktok.controller';
import { TiktokApiService } from './services/tiktok-api.service';
import { TiktokAuthService } from './services/tiktok-auth.service';
import { TiktokIngestService } from './services/tiktok-ingest.service';
import { TiktokQuotaService } from './services/tiktok-quota.service';
import { TiktokService } from './services/tiktok.service';

@Module({
	imports: [ProvidersModule, AuthModuleModule, SocialStatsSharedModule],
	controllers: [TiktokController],
	providers: [
		TiktokAuthService,
		TiktokQuotaService,
		TiktokApiService,
		TiktokService,
		TiktokIngestService
	]
})
export class TiktokModule { }
