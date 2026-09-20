import { YoutubeVideoDailyStats } from '../../entity';

export const YoutubeVideoDailyStatsProvider = [
	{
		provide: 'YOUTUBE_VIDEO_DAILY_STATS_REPOSITORY',
		useValue: YoutubeVideoDailyStats
	}
];
