import {
	AutoIncrement,
	Column,
	DataType,
	Model,
	PrimaryKey,
	Table,
	Unique
} from 'sequelize-typescript';

/**
 * Per-video engagement snapshots from /v2/video/list/, one row per (videoId, capturedAt).
 *
 * Two TikTok-specific constraints shape this table:
 *
 * 1. `coverImageUrl` and `embedLink` are signed, short-lived CDN URLs (cover images expire
 *    within hours). They are stored only as a rendering convenience and MUST be treated as
 *    stale on read — never surfaced as permanent links. TikTok's Developer Terms also forbid
 *    caching the media itself, so only these references are kept, never downloaded files.
 * 2. TikTok requires that content data be kept current and removed once the creator deletes
 *    the post or revokes the app's access. `deletedAt` marks rows whose video disappeared
 *    from the creator's list so the purge job can drop them without losing the audit trail
 *    in the same tick — see TiktokIngestService.purgeStaleContent.
 */
@Table({
	tableName: 'TiktokVideoStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class TiktokVideoStats extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	openId: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	videoId: string;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	title: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	videoDescription: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	postedAt: Date | null;

	@Column({
		type: DataType.INTEGER,
		allowNull: true
	})
	durationSeconds: number | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	coverImageUrl: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	shareUrl: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	embedLink: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	viewCount: number;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	likeCount: number;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	commentCount: number;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	shareCount: number;

	@Column({
		type: DataType.DATE,
		allowNull: false,
		defaultValue: DataType.NOW
	})
	capturedAt: Date;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	deletedAt: Date | null;
}
