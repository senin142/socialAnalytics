import { MetaFacebookPosts } from '../../entity';

export const MetaFacebookPostsProvider = [
	{
		provide: 'META_FACEBOOK_POSTS_REPOSITORY',
		useValue: MetaFacebookPosts
	}
];
