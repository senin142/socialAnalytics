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
	tableName: 'SocialStatsDataCoverage',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class SocialStatsDataCoverage extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	platform: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	jobType: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	metricKey: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	scope: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	status: string;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	reason: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	lastAttemptAt: Date | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	lastSuccessAt: Date | null;

	@Column({
		type: DataType.INTEGER,
		allowNull: false,
		defaultValue: 0
	})
	consecutiveFailures: number;
}
