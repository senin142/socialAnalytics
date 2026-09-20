import { YoutubeAnalyticsSnapshots } from '../../entity';

export const YoutubeAnalyticsSnapshotsProvider = [
	{
		provide: 'YOUTUBE_ANALYTICS_SNAPSHOTS_REPOSITORY',
		useValue: YoutubeAnalyticsSnapshots
	}
];
