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
	tableName: 'MetaFacebookPosts',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class MetaFacebookPosts extends Model {
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
	postId: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	pageId: string;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	message: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	createdTime: Date | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	permalink: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	type: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	statusType: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	shares: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	likes: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	comments: string | null;

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
	interactions: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	engagementSource: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	videoViews: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	videoAvgTimeWatchedMs: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	videoCompleteViews30s: string | null;

	// JSON object keyed by reaction type ({like, love, wow, haha, sorry, anger, ...}),
	// same shape Meta returns for the page-level page_actions_post_reactions_total metric.
	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	reactionsByType: string | null;

	// Raw JSON as Meta returns it for post_video_retention_graph — shape isn't pinned to a
	// column structure since it wasn't verified live before this was built (see
	// METRICS_BACKLOG.txt item 1); consumers should treat it as opaque until confirmed.
	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	videoRetentionGraph: string | null;

	// The two Reels-specific metrics only resolve via /{reel-id}/video_insights, not
	// /{postId}/insights — see METRICS_BACKLOG.txt item 3 (verified live 2026-09-18). Rows
	// for non-reel posts leave these null.
	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	blueReelsPlayCount: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	fbReelsTotalPlays: string | null;

	// Free on the same /video_reels listing call that supplies the two metrics above.
	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	reelPostViews: string | null;

	@Column({
		type: DataType.FLOAT,
		allowNull: true
	})
	reelLengthSeconds: number | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	rawJson: string | null;
}
