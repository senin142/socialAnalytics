import { MetaInstagramStoryStats } from '../../entity';

export const MetaInstagramStoryStatsProvider = [
	{
		provide: 'META_INSTAGRAM_STORY_STATS_REPOSITORY',
		useValue: MetaInstagramStoryStats
	}
];
