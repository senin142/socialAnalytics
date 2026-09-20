import { AuthModuleModule } from '../../auth';
import { ProvidersModule } from '../../database/providers';
import { Module } from '@nestjs/common';
import { SocialStatsSharedModule } from '../shared/socialstats-shared.module';
import { MetaClientController } from './controllers/meta.client.controller';
import { MetaController } from './controllers/meta.controller';
import { MetaAuthService } from './services/meta-auth.service';
import { MetaApiService } from './services/meta-api.service';
import { MetaBackfillWalkService } from './services/meta-backfill-walk.service';
import { MetaFacebookService } from './services/meta-facebook.service';
import { MetaGeoService } from './services/meta-geo.service';
import { MetaDashboardService } from './services/meta-dashboard.service';
import { MetaIngestService } from './services/meta-ingest.service';
import { MetaIngestSchedulerService } from './services/meta-ingest.scheduler.service';
import { MetaInstagramService } from './services/meta-instagram.service';
import { MetaRateLimitService } from './services/meta-rate-limit.service';

@Module({
	imports: [ProvidersModule, AuthModuleModule, SocialStatsSharedModule],
	controllers: [MetaController, MetaClientController],
	providers: [
		MetaAuthService,
		MetaApiService,
		MetaRateLimitService,
		MetaFacebookService,
		MetaInstagramService,
		MetaGeoService,
		MetaDashboardService,
		MetaIngestService,
		MetaIngestSchedulerService,
		MetaBackfillWalkService
	]
})
export class MetaModule { }
