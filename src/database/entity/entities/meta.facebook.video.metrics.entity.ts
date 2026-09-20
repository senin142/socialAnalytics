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
	tableName: 'MetaFacebookVideoMetrics',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class MetaFacebookVideoMetrics extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	videoId: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	pageId: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	title: string | null;

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
		allowNull: false
	})
	metric: string;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	value: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	endTime: Date | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	rawJson: string | null;
}
