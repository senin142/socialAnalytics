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
	tableName: 'MetaAccountTokens',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class MetaAccountTokens extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	platformScope: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	accountType: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	metaAppId: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	userId: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	pageId: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	instagramBusinessAccountId: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: false
	})
	accessToken: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	tokenType: string | null;

	@Column({
		type: DataType.TEXT,
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
	lastRefreshedAt: Date | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	lastValidatedAt: Date | null;

	@Column({
		type: DataType.BOOLEAN,
		allowNull: false,
		defaultValue: false
	})
	isExpired: boolean;

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
