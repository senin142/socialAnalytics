import { YoutubeReportingJobState } from '../../entity';

export const YoutubeReportingJobStateProvider = [
	{
		provide: 'YOUTUBE_REPORTING_JOB_STATE_REPOSITORY',
		useValue: YoutubeReportingJobState
	}
];
