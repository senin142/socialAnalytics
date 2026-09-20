import { YoutubeQuotaUsage } from '../../entity';

export const YoutubeQuotaUsageProvider = [
	{
		provide: 'YOUTUBE_QUOTA_USAGE_REPOSITORY',
		useValue: YoutubeQuotaUsage
	}
];
