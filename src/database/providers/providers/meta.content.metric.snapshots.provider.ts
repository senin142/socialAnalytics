import { MetaContentMetricSnapshots } from '../../entity';

export const MetaContentMetricSnapshotsProvider = [
	{
		provide: 'META_CONTENT_METRIC_SNAPSHOTS_REPOSITORY',
		useValue: MetaContentMetricSnapshots
	}
];
