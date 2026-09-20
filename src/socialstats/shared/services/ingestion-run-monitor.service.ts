import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IngestionRunsService } from './ingestion-runs.service';

@Injectable()
export class IngestionRunMonitorService {
	private readonly logger = new Logger(IngestionRunMonitorService.name);

	constructor(private readonly ingestionRunsService: IngestionRunsService) { }

	@Cron('*/5 * * * *')
	async reconcileExpiredRuns() {
		try {
			const reconciledCount = await this.ingestionRunsService.markExpiredRunningRunsFailed();
			if (reconciledCount > 0) {
				this.logger.warn(
					`Marked ${reconciledCount} expired ingestion run(s) as failed`
				);
			}
		} catch (error: any) {
			this.logger.error(
				`Unable to reconcile expired ingestion runs: ${error?.message || 'Unknown error'}`
			);
		}
	}
}
