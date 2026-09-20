import {
	MetaFacebookPages,
	MetaFacebookPosts
} from '../../../database/entity';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class MetaFacebookService {
	constructor(
		@Inject('META_FACEBOOK_PAGES_REPOSITORY')
		private readonly metaFacebookPagesRepo: typeof MetaFacebookPages,
		@Inject('META_FACEBOOK_POSTS_REPOSITORY')
		private readonly metaFacebookPostsRepo: typeof MetaFacebookPosts
	) { }

	async getPages() {
		const pages = await this.metaFacebookPagesRepo.findAll({
			order: [['updatedAt', 'DESC']],
			raw: true
		});

		return {
			statusCode: 200,
			message: 'Meta Facebook pages fetched successfully',
			data: pages
		};
	}

	async getPosts(pageId?: string) {
		const posts = await this.metaFacebookPostsRepo.findAll({
			where: pageId ? { pageId } : undefined,
			order: [['createdTime', 'DESC']],
			raw: true
		});

		return {
			statusCode: 200,
			message: 'Meta Facebook posts fetched successfully',
			data: posts
		};
	}
}
