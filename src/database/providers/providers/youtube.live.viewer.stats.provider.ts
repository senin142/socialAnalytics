import { YoutubeLiveViewerStats } from '../../entity';

export const YoutubeLiveViewerStatsProvider = [
	{
		provide: 'YOUTUBE_LIVE_VIEWER_STATS_REPOSITORY',
		useValue: YoutubeLiveViewerStats
	}
];
