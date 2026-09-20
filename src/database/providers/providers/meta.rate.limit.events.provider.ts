import { MetaRateLimitEvents } from '../../entity';

export const MetaRateLimitEventsProvider = [
	{
		provide: 'META_RATE_LIMIT_EVENTS_REPOSITORY',
		useValue: MetaRateLimitEvents
	}
];
