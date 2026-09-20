import { LinkedinApiUsage } from '../../entity';

export const LinkedinApiUsageProvider = [
	{
		provide: 'LINKEDIN_API_USAGE_REPOSITORY',
		useValue: LinkedinApiUsage
	}
];
