import {
	AutoIncrement,
	Column,
	DataType,
	Model,
	PrimaryKey,
	Table,
	Unique
} from 'sequelize-typescript';

@Table({
	tableName: 'MetaInstagramMedia',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class MetaInstagramMedia extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Unique
	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	mediaId: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	instagramId: string;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	caption: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	mediaType: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	mediaUrl: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	permalink: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	timestamp: Date | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	likeCount: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	commentsCount: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	saved: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	reach: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	impressions: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	engagement: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	videoViews: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	shares: string | null;

	/** Reels only (ig_reels_avg_watch_time / ig_reels_video_view_total_time), in ms. */
	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	reelsAvgWatchTimeMs: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	reelsTotalWatchTimeMs: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	rawJson: string | null;
}
