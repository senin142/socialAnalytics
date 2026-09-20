import {
	AutoIncrement,
	Column,
	DataType,
	Model,
	PrimaryKey,
	Table
} from 'sequelize-typescript';

/**
 * Views and watch time per video per day per traffic source type, for the whole catalog,
 * from the Reporting API's `channel_traffic_source_a3` bulk report (aggregated over
 * country / live-or-on-demand / subscribed-status / source detail). The interactive
 * Analytics API only offers this at channel level or for one video at a time.
 */
@Table({
	tableName: 'YoutubeVideoTrafficSourceStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true,
	indexes: [
		{ name: 'idx_yvtss_video_date_source', unique: true, fields: ['videoId', 'statDate', 'trafficSourceType'] },
		{ name: 'idx_yvtss_date', fields: ['statDate'] }
	]
})
export class YoutubeVideoTrafficSourceStats extends Model {
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

	/** Reporting API enum: e.g. YT_SEARCH, EXT_URL, RELATED_VIDEO, SHORTS, SUBSCRIBER … */
	@Column({ type: DataType.STRING, allowNull: false })
	trafficSourceType: string;

	@Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
	views: number;

	@Column({ type: DataType.DECIMAL(14, 3), allowNull: false, defaultValue: 0 })
	watchTimeMinutes: string;

	@Column({ type: DataType.STRING, allowNull: true })
	reportId: string | null;

	@Column({ type: DataType.DATE, allowNull: false })
	fetchedAt: Date;
}
