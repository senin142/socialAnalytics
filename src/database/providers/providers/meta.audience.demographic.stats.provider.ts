import { MetaAudienceDemographicStats } from '../../entity';

export const MetaAudienceDemographicStatsProvider = [
	{
		provide: 'META_AUDIENCE_DEMOGRAPHIC_STATS_REPOSITORY',
		useValue: MetaAudienceDemographicStats
	}
];
