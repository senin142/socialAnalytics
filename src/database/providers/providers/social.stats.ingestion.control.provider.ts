import { SocialStatsIngestionControl } from '../../entity';

export const SocialStatsIngestionControlProvider = [
	{
		provide: 'SOCIAL_STATS_INGESTION_CONTROL_REPOSITORY',
		useValue: SocialStatsIngestionControl
	}
];
