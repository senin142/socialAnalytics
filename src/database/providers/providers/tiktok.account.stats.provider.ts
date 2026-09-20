import { TiktokAccountStats } from '../../entity';

export const TiktokAccountStatsProvider = [
	{
		provide: 'TIKTOK_ACCOUNT_STATS_REPOSITORY',
		useValue: TiktokAccountStats
	}
];
