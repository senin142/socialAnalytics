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
	tableName: 'YoutubeReportingJobState',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class YoutubeReportingJobState extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false,
		unique: true
	})
	reportTypeId: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	jobId: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	lastProcessedReportId: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	lastProcessedCreateTime: Date | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	lastSyncedAt: Date | null;
}
