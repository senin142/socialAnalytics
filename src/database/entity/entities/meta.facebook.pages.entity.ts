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
	tableName: 'MetaFacebookPages',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class MetaFacebookPages extends Model {
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
	pageId: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	name: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	category: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	followers: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	fans: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	postCount: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	picture: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	about: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	website: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	pageLink: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	lastIngestedAt: Date | null;
}
