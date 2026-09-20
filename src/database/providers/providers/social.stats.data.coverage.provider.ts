import { SocialStatsDataCoverage } from '../../entity';

export const SocialStatsDataCoverageProvider = [
	{
		provide: 'SOCIAL_STATS_DATA_COVERAGE_REPOSITORY',
		useValue: SocialStatsDataCoverage
	}
];
