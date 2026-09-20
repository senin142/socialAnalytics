import { MetaVideoGeoStats } from '../../entity';

export const MetaVideoGeoStatsProvider = [
	{
		provide: 'META_VIDEO_GEO_STATS_REPOSITORY',
		useValue: MetaVideoGeoStats
	}
];
