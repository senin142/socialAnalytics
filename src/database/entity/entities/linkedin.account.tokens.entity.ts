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
 * Standard-tier LinkedIn developer apps are NOT issued a refresh_token (that requires
 * approved Marketing Developer Platform partner status) — access tokens are ~60 days and,
 * once expired, require an admin to click back through the OAuth consent screen. This table
 * tracks that expiry explicitly so LinkedinAuthService can fail with a clear "re-authorize"
 * message instead of silently retrying like the Google/Meta token flows do.
 */
@Table({
	tableName: 'LinkedinAccountTokens',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class LinkedinAccountTokens extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	organizationUrn: string;

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
}
