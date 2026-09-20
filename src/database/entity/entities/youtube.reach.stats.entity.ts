import {
	AutoIncrement,
	Column,
	DataType,
	Model,
	PrimaryKey,
	Table
} from 'sequelize-typescript';

@Table({
	tableName: 'YoutubeReachStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true,
	indexes: [
		{ name: 'idx_yrs_video_date', unique: true, fields: ['videoId', 'statDate'] }
	]
})
export class YoutubeReachStats extends Model {
	@PrimaryKey
	@AutoIncrement
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	channelId: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	videoId: string;

	@Column({
		type: DataType.DATEONLY,
		allowNull: false
	})
	statDate: string;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	videoThumbnailImpressions: number;

	@Column({
		type: DataType.DECIMAL(10, 6),
		allowNull: true
	})
	videoThumbnailImpressionsClickRate: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	reportId: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: false,
		defaultValue: DataType.NOW
	})
	fetchedAt: Date;
}
