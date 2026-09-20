import {
	MetaInstagramMedia,
	MetaInstagramProfiles
} from '../../../database/entity';
import {
	BadGatewayException,
	BadRequestException,
	Inject,
	Injectable
} from '@nestjs/common';
import { MetaApiService } from './meta-api.service';
import { MetaAuthService } from './meta-auth.service';

@Injectable()
export class MetaInstagramService {
	constructor(
		private readonly metaAuthService: MetaAuthService,
		private readonly metaApiService: MetaApiService,
		@Inject('META_INSTAGRAM_PROFILES_REPOSITORY')
		private readonly metaInstagramProfilesRepo: typeof MetaInstagramProfiles,
		@Inject('META_INSTAGRAM_MEDIA_REPOSITORY')
		private readonly metaInstagramMediaRepo: typeof MetaInstagramMedia
	) { }

	async getProfiles() {
		const profiles = await this.metaInstagramProfilesRepo.findAll({
			order: [['updatedAt', 'DESC']],
			raw: true
		});

		return {
			statusCode: 200,
			message: 'Meta Instagram profiles fetched successfully',
			data: profiles
		};
	}

	async getMedia(instagramId?: string) {
		const media = await this.metaInstagramMediaRepo.findAll({
			where: instagramId ? { instagramId } : undefined,
			order: [['timestamp', 'DESC']],
			raw: true
		});

		return {
			statusCode: 200,
			message: 'Meta Instagram media fetched successfully',
			data: media
		};
	}

	async debugAudienceInsights(options?: {
		pageId?: string;
		instagramId?: string;
		metric?: string;
		breakdown?: string;
		timeframe?: string;
	}) {
		const pageTokenRow = await this.metaAuthService.getEffectivePageToken(options?.pageId);
		const instagramId = await this.resolveInstagramId(
			pageTokenRow.pageId,
			pageTokenRow.instagramBusinessAccountId ?? null,
			options?.instagramId
		);
		if (!instagramId) {
			throw new BadRequestException(
				'instagramId is required or must be discoverable from the stored Meta page token/profile'
			);
		}

		const metric = String(options?.metric || 'follower_demographics').trim();
		const breakdown = String(options?.breakdown || 'country').trim().toLowerCase();
		const timeframe = String(options?.timeframe || '').trim() || null;

		try {
			const response = await this.metaApiService.get<any>(`/${instagramId}/insights`, {
				accessToken: pageTokenRow.accessToken,
				params: {
					metric,
					metric_type: 'total_value',
					breakdown,
					period: 'lifetime',
					...(timeframe ? { timeframe } : {})
				},
				endpointLabel: `instagram_audience_debug_${metric}_${breakdown}${timeframe ? `_${timeframe}` : ''}`
			});

			return {
				statusCode: 200,
				message: 'Meta Instagram audience insights debug fetched successfully',
				data: {
					request: {
						pageId: pageTokenRow.pageId,
						instagramId,
						metric,
						breakdown,
						period: 'lifetime',
						timeframe,
						tokenSource: 'stored_page_token'
					},
					response
				}
			};
		} catch (error: any) {
			throw new BadGatewayException(
				`Unable to fetch Meta Instagram audience insights debug: ${
					error?.response?.data?.error?.message ||
					error?.response?.data?.message ||
					error?.message ||
					'Unknown Meta API error'
				}`
			);
		}
	}

	private async resolveInstagramId(
		pageId: string,
		tokenInstagramId?: string | null,
		requestInstagramId?: string
	) {
		if (requestInstagramId) {
			return requestInstagramId;
		}
		if (tokenInstagramId) {
			return tokenInstagramId;
		}
		if (process.env.META_INSTAGRAM_ACCOUNT_ID) {
			return process.env.META_INSTAGRAM_ACCOUNT_ID;
		}

		const profile = await this.metaInstagramProfilesRepo.findOne({
			where: { pageId },
			order: [['updatedAt', 'DESC']]
		});
		return profile?.instagramId || null;
	}
}
