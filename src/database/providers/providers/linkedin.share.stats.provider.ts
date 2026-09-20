import { LinkedinShareStats } from '../../entity';

export const LinkedinShareStatsProvider = [
	{
		provide: 'LINKEDIN_SHARE_STATS_REPOSITORY',
		useValue: LinkedinShareStats
	}
];
