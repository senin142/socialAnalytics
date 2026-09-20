import { MetaInstagramProfiles } from '../../entity';

export const MetaInstagramProfilesProvider = [
	{
		provide: 'META_INSTAGRAM_PROFILES_REPOSITORY',
		useValue: MetaInstagramProfiles
	}
];
