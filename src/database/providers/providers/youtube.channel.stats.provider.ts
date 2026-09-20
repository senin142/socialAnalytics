import { YoutubeChannelStats } from '../../entity';

export const YoutubeChannelStatsProvider = [
	{
		provide: 'YOUTUBE_CHANNEL_STATS_REPOSITORY',
		useValue: YoutubeChannelStats
	}
];
