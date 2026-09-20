import { LinkedinOrganizationStats } from '../../entity';

export const LinkedinOrganizationStatsProvider = [
	{
		provide: 'LINKEDIN_ORGANIZATION_STATS_REPOSITORY',
		useValue: LinkedinOrganizationStats
	}
];
