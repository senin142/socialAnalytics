import { MetaFacebookVideoMetrics } from '../../entity';

export const MetaFacebookVideoMetricsProvider = [
	{
		provide: 'META_FACEBOOK_VIDEO_METRICS_REPOSITORY',
		useValue: MetaFacebookVideoMetrics
	}
];
