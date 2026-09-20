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
	tableName: 'YoutubeQuotaUsage',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class YoutubeQuotaUsage extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.DATEONLY,
		allowNull: false
	})
	usageDate: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	pool: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	endpoint: string;

	@Column({
		type: DataType.INTEGER,
		allowNull: false,
		defaultValue: 0
	})
	unitsUsed: number;

	@Column({
		type: DataType.INTEGER,
		allowNull: false,
		defaultValue: 0
	})
	callCount: number;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	lastCallAt: Date | null;
}
