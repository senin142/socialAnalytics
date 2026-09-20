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
	tableName: 'MetaRateLimitEvents',
	freezeTableName: true,
	paranoid: false,
	timestamps: true,
	// The rate-limit service re-reads "events still inside their retry window" every
	// 30s to share cooldowns across instances, and the status endpoint lists the latest
	// 20 — both are recent-first scans on occurredAt. Existing databases got this via
	// CREATE INDEX CONCURRENTLY under the same name.
	indexes: [
		{
			name: 'idx_mrle_occurred_at',
			fields: [{ name: 'occurredAt', order: 'DESC' }]
		}
	]
})
export class MetaRateLimitEvents extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	source: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	endpoint: string;

	@Column({
		type: DataType.INTEGER,
		allowNull: true
	})
	errorCode: number | null;

	@Column({
		type: DataType.INTEGER,
		allowNull: true
	})
	errorSubcode: number | null;

	@Column({
		type: DataType.BOOLEAN,
		allowNull: false,
		defaultValue: false
	})
	isTransient: boolean;

	@Column({
		type: DataType.INTEGER,
		allowNull: true
	})
	retryAfterSeconds: number | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	appUsage: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	pageUsage: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: false,
		defaultValue: DataType.NOW
	})
	occurredAt: Date;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	rawJson: string | null;
}
