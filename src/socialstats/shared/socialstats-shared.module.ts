import { ProvidersModule } from '../../database/providers';
import { Module } from '@nestjs/common';
import { DataCoverageService } from './services/data-coverage.service';
import { IngestionControlService } from './services/ingestion-control.service';
import { IngestionRunMonitorService } from './services/ingestion-run-monitor.service';
import { IngestionRunsService } from './services/ingestion-runs.service';
import { IngestionStatusService } from './services/ingestion-status.service';
import { SocialStatsClientTokenService } from './services/socialstats-client-token.service';

@Module({
	imports: [ProvidersModule],
	providers: [
		IngestionRunsService,
		IngestionStatusService,
		IngestionRunMonitorService,
		SocialStatsClientTokenService,
		DataCoverageService,
		IngestionControlService
	],
	exports: [
		IngestionRunsService,
		IngestionStatusService,
		SocialStatsClientTokenService,
		DataCoverageService,
		IngestionControlService
	]
})
export class SocialStatsSharedModule { }
