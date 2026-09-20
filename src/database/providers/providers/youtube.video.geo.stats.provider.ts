import { YoutubeVideoGeoStats } from '../../entity';

export const YoutubeVideoGeoStatsProvider = [
	{
		provide: 'YOUTUBE_VIDEO_GEO_STATS_REPOSITORY',
		useValue: YoutubeVideoGeoStats
	}
];
