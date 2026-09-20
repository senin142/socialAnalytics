import { LinkedinFollowerStats } from '../../entity';

export const LinkedinFollowerStatsProvider = [
	{
		provide: 'LINKEDIN_FOLLOWER_STATS_REPOSITORY',
		useValue: LinkedinFollowerStats
	}
];
