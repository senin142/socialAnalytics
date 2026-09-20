import { MetaBackfillWalkState } from '../../entity';

export const MetaBackfillWalkStateProvider = [
	{
		provide: 'META_BACKFILL_WALK_STATE_REPOSITORY',
		useValue: MetaBackfillWalkState
	}
];
