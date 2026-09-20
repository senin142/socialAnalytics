import { IngestionRuns } from '../../entity';

export const IngestionRunsProvider = [
	{
		provide: 'INGESTION_RUNS_REPOSITORY',
		useValue: IngestionRuns
	}
];
