import { TiktokAccountTokens } from '../../entity';

export const TiktokAccountTokensProvider = [
	{
		provide: 'TIKTOK_ACCOUNT_TOKENS_REPOSITORY',
		useValue: TiktokAccountTokens
	}
];
