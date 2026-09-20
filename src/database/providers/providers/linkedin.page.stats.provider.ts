import { LinkedinPageStats } from '../../entity';

export const LinkedinPageStatsProvider = [
	{
		provide: 'LINKEDIN_PAGE_STATS_REPOSITORY',
		useValue: LinkedinPageStats
	}
];
