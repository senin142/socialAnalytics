import { TiktokApiUsage } from '../../entity';

export const TiktokApiUsageProvider = [
	{
		provide: 'TIKTOK_API_USAGE_REPOSITORY',
		useValue: TiktokApiUsage
	}
];
