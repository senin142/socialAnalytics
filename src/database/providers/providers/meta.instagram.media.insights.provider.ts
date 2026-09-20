import { MetaInstagramMediaInsights } from '../../entity';

export const MetaInstagramMediaInsightsProvider = [
	{
		provide: 'META_INSTAGRAM_MEDIA_INSIGHTS_REPOSITORY',
		useValue: MetaInstagramMediaInsights
	}
];
