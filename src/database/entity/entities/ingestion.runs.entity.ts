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
	tableName: 'IngestionRuns',
	freezeTableName: true,
	paranoid: false,
	timestamps: true,
	// Every cron tick asks "is this job already running?" and every status call asks
	// "when did this job last succeed?" — the first index serves both; the second serves
	// the lease-expiry monitor. Existing databases got them via CREATE INDEX CONCURRENTLY
	// under the same names.
	indexes: [
		{
			name: 'idx_ir_job_status_finished',
			fields: ['platform', 'jobType', 'status', { name: 'finishedAt', order: 'DESC' }]
		},
		{
			name: 'idx_ir_running_lease',
			fields: ['status', 'leaseExpiresAt']
		}
	]
})
export class IngestionRuns extends Model {
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
	entityType: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	entityId: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	jobType: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	runType: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	triggerSource: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	status: string;

	@Column({
		type: DataType.INTEGER,
		allowNull: false,
		defaultValue: 1
	})
	attempt: number;

	@Column({
		type: DataType.INTEGER,
		allowNull: true
	})
	parentRunId: number | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	leasedBy: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	leaseExpiresAt: Date | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	heartbeatAt: Date | null;

	@Column({
		type: DataType.DATEONLY,
		allowNull: true
	})
	scopeStartDate: string | null;

	@Column({
		type: DataType.DATEONLY,
		allowNull: true
	})
	scopeEndDate: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	cursor: string | null;

	@Column({
		type: DataType.INTEGER,
		allowNull: false,
		defaultValue: 0
	})
	recordsFetched: number;

	@Column({
		type: DataType.INTEGER,
		allowNull: false,
		defaultValue: 0
	})
	recordsProcessed: number;

	@Column({
		type: DataType.INTEGER,
		allowNull: false,
		defaultValue: 0
	})
	recordsUpserted: number;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	errorCode: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	errorMessage: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	metadata: string | null;

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
		type: DataType.STRING,
		allowNull: true
	})
	instanceId: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	revision: string | null;
}
