import {
	AutoIncrement,
	Column,
	DataType,
	Model,
	PrimaryKey,
	Table
} from 'sequelize-typescript';

/**
 * One row per video per day for the WHOLE catalog, from the YouTube Reporting API's
 * `channel_basic_a3` bulk report. The report itself is one row per video × country ×
 * live/on-demand × subscribed-status; that is aggregated to the video-day here (with the
 * live and subscribed splits kept as sums) so the table stays ~1–2k rows/day instead of
 * ~100k. This is what makes "every video, every day" possible — the interactive Analytics
 * API path only ever tracks the top N videos, and costs quota per call.
 */
@Table({
	tableName: 'YoutubeVideoDailyStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true,
	indexes: [
		{ name: 'idx_yvds_video_date', unique: true, fields: ['videoId', 'statDate'] },
		{ name: 'idx_yvds_date', fields: ['statDate'] }
	]
})
export class YoutubeVideoDailyStats extends Model {
	@PrimaryKey
	@AutoIncrement
	@Column
	id: number;

	@Column({ type: DataType.STRING, allowNull: true })
	channelId: string | null;

	@Column({ type: DataType.STRING, allowNull: false })
	videoId: string;

	@Column({ type: DataType.DATEONLY, allowNull: false })
	statDate: string;

	@Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
	views: number;

	@Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
	liveViews: number;

	@Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
	subscribedViews: number;

	@Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
	redViews: number;

	@Column({ type: DataType.DECIMAL(14, 3), allowNull: false, defaultValue: 0 })
	watchTimeMinutes: string;

	/** Weighted by views across the report's sub-rows. */
	@Column({ type: DataType.DECIMAL(10, 3), allowNull: true })
	averageViewDurationSeconds: string | null;

	/**
	 * DECIMAL(10,3), not (6,3): YouTube can report >100% here for Shorts/looped content
	 * (viewers rewatch a short video multiple times per session), so a tight cap on this
	 * column previously caused "numeric field overflow" on otherwise-valid report rows.
	 */
	@Column({ type: DataType.DECIMAL(10, 3), allowNull: true })
	averageViewDurationPercentage: string | null;

	@Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
	likes: number;

	@Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
	dislikes: number;

	@Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
	comments: number;

	@Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
	shares: number;

	@Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
	subscribersGained: number;

	@Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
	subscribersLost: number;

	@Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
	videosAddedToPlaylists: number;

	@Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
	videosRemovedFromPlaylists: number;

	@Column({ type: DataType.STRING, allowNull: true })
	reportId: string | null;

	@Column({ type: DataType.DATE, allowNull: false })
	fetchedAt: Date;
}
