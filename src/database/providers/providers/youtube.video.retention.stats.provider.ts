import { YoutubeVideoRetentionStats } from '../../entity';

export const YoutubeVideoRetentionStatsProvider = [
	{
		provide: 'YOUTUBE_VIDEO_RETENTION_STATS_REPOSITORY',
		useValue: YoutubeVideoRetentionStats
	}
];
