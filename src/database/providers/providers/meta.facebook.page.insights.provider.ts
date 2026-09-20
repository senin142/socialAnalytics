import { MetaFacebookPageInsights } from '../../entity';

export const MetaFacebookPageInsightsProvider = [
	{
		provide: 'META_FACEBOOK_PAGE_INSIGHTS_REPOSITORY',
		useValue: MetaFacebookPageInsights
	}
];
