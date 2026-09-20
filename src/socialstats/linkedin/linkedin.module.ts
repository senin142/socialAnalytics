import { AuthModuleModule } from '../../auth';
import { ProvidersModule } from '../../database/providers';
import { Module } from '@nestjs/common';
import { SocialStatsSharedModule } from '../shared/socialstats-shared.module';
import { LinkedinController } from './controllers/linkedin.controller';
import { LinkedinApiService } from './services/linkedin-api.service';
import { LinkedinAuthService } from './services/linkedin-auth.service';
import { LinkedinIngestService } from './services/linkedin-ingest.service';
import { LinkedinQuotaService } from './services/linkedin-quota.service';
import { LinkedinService } from './services/linkedin.service';

@Module({
	imports: [ProvidersModule, AuthModuleModule, SocialStatsSharedModule],
	controllers: [LinkedinController],
	providers: [
		LinkedinAuthService,
		LinkedinQuotaService,
		LinkedinApiService,
		LinkedinService,
		LinkedinIngestService
	]
})
export class LinkedinModule { }
