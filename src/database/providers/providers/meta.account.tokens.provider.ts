import { MetaAccountTokens } from '../../entity';

export const MetaAccountTokensProvider = [
	{
		provide: 'META_ACCOUNT_TOKENS_REPOSITORY',
		useValue: MetaAccountTokens
	}
];
