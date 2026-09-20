import { MetaAudienceGeoStats } from '../../entity';

export const MetaAudienceGeoStatsProvider = [
	{
		provide: 'META_AUDIENCE_GEO_STATS_REPOSITORY',
		useValue: MetaAudienceGeoStats
	}
];
