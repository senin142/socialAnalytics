import { YoutubeReachStats } from '../../entity';

export const YoutubeReachStatsProvider = [
	{
		provide: 'YOUTUBE_REACH_STATS_REPOSITORY',
		useValue: YoutubeReachStats
	}
];
