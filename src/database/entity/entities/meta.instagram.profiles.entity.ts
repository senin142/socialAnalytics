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
	tableName: 'MetaInstagramProfiles',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class MetaInstagramProfiles extends Model {
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
	instagramId: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	pageId: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	username: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	followers: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	follows: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	mediaCount: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	postCount: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	profilePictureUrl: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	lastIngestedAt: Date | null;
}
