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
 * TikTok access tokens live for only 24 hours (vs LinkedIn's ~60 days and Google's 1 hour +
 * long-lived refresh), and the refresh token ROTATES — every refresh returns a brand new
 * refresh_token and invalidates the one just used. That makes this row the single source of
 * truth that must be written on every refresh: losing a rotated refresh_token means the only
 * way back is a full re-authorization by the account holder.
 *
 * `openId` is TikTok's per-app pseudonymous account id (the same account authorizing a
 * different app gets a different openId); `unionId` is stable across apps owned by the same
 * developer. Both are treated as personal data under TikTok's Developer Terms, which is why
 * revokedAt exists — on revocation the token must be dropped rather than left to expire.
 */
@Table({
	tableName: 'TiktokAccountTokens',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class TiktokAccountTokens extends Model {
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
	unionId: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: false
	})
	accessToken: string;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	refreshToken: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true,
		defaultValue: 'Bearer'
	})
	tokenType: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	scopes: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	expiresAt: Date | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	refreshTokenExpiresAt: Date | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	lastRefreshedAt: Date | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	refreshStatus: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	lastError: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	revokedAt: Date | null;
}
