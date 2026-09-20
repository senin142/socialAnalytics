import { MetaFacebookPages } from '../../entity';

export const MetaFacebookPagesProvider = [
	{
		provide: 'META_FACEBOOK_PAGES_REPOSITORY',
		useValue: MetaFacebookPages
	}
];
