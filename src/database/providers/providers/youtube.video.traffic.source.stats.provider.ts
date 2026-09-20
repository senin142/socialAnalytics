import { YoutubeVideoTrafficSourceStats } from '../../entity';

export const YoutubeVideoTrafficSourceStatsProvider = [
	{
		provide: 'YOUTUBE_VIDEO_TRAFFIC_SOURCE_STATS_REPOSITORY',
		useValue: YoutubeVideoTrafficSourceStats
	}
];
