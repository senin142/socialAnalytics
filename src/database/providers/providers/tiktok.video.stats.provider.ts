import { TiktokVideoStats } from '../../entity';

export const TiktokVideoStatsProvider = [
	{
		provide: 'TIKTOK_VIDEO_STATS_REPOSITORY',
		useValue: TiktokVideoStats
	}
];
