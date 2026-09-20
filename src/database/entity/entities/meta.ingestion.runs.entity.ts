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
	tableName: 'MetaIngestionRuns',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class MetaIngestionRuns extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	jobType: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	scope: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	status: string;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	cursor: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: false,
		defaultValue: DataType.NOW
	})
	startedAt: Date;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	finishedAt: Date | null;

	@Column({
		type: DataType.INTEGER,
		allowNull: false,
		defaultValue: 0
	})
	retryCount: number;

	@Column({
		type: DataType.INTEGER,
		allowNull: false,
		defaultValue: 0
	})
	recordsProcessed: number;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	lastError: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	metadata: string | null;
}
