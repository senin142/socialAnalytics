import { YoutubeGeoDeviceStats } from '../../entity';

export const YoutubeGeoDeviceStatsProvider = [
	{
		provide: 'YOUTUBE_GEO_DEVICE_STATS_REPOSITORY',
		useValue: YoutubeGeoDeviceStats
	}
];
