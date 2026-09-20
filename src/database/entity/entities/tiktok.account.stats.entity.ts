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
 * One snapshot row per fetch of /v2/user/info/ (same time-series shape as
 * LinkedinOrganizationStats), so follower growth is derivable from history rather than only
 * the latest value.
 *
 * Every count here requires the `user.info.stats` scope and every profile string requires
 * `user.info.profile` — as of TikTok's Feb 2024 scope migration `user.info.basic` no longer
 * returns them. Columns are nullable because a token granted only a subset of scopes still
 * returns a valid 200 with those fields simply absent, which is recorded as a coverage gap
 * rather than a failure.
 */
@Table({
	tableName: 'TiktokAccountStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class TiktokAccountStats extends Model {
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
		allowNull: true
	})
	username: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	displayName: string | null;

	@Column({
		type: DataType.BOOLEAN,
		allowNull: true
	})
	isVerified: boolean | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	followerCount: number | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	followingCount: number | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	likesCount: number | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	videoCount: number | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	profileDeepLink: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: false,
		defaultValue: DataType.NOW
	})
	fetchedAt: Date;
}
