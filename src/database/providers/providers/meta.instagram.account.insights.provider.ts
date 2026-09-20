import { MetaInstagramAccountInsights } from '../../entity';

export const MetaInstagramAccountInsightsProvider = [
	{
		provide: 'META_INSTAGRAM_ACCOUNT_INSIGHTS_REPOSITORY',
		useValue: MetaInstagramAccountInsights
	}
];
