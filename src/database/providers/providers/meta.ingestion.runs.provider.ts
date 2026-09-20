import { MetaIngestionRuns } from '../../entity';

export const MetaIngestionRunsProvider = [
	{
		provide: 'META_INGESTION_RUNS_REPOSITORY',
		useValue: MetaIngestionRuns
	}
];
