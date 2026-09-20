import { MetaInstagramMedia } from '../../entity';

export const MetaInstagramMediaProvider = [
	{
		provide: 'META_INSTAGRAM_MEDIA_REPOSITORY',
		useValue: MetaInstagramMedia
	}
];
