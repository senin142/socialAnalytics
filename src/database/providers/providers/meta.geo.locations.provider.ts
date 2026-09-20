import { MetaGeoLocations } from '../../entity';

export const MetaGeoLocationsProvider = [
	{
		provide: 'META_GEO_LOCATIONS_REPOSITORY',
		useValue: MetaGeoLocations
	}
];
