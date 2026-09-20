import { LinkedinAccountTokens } from '../../entity';

export const LinkedinAccountTokensProvider = [
	{
		provide: 'LINKEDIN_ACCOUNT_TOKENS_REPOSITORY',
		useValue: LinkedinAccountTokens
	}
];
