import { YoutubeBackfillWalkState } from '../../entity';

export const YoutubeBackfillWalkStateProvider = [
	{
		provide: 'YOUTUBE_BACKFILL_WALK_STATE_REPOSITORY',
		useValue: YoutubeBackfillWalkState
	}
];
