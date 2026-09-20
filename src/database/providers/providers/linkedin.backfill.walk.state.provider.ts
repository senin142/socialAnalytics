import { LinkedinBackfillWalkState } from '../../entity';

export const LinkedinBackfillWalkStateProvider = [
	{
		provide: 'LINKEDIN_BACKFILL_WALK_STATE_REPOSITORY',
		useValue: LinkedinBackfillWalkState
	}
];
