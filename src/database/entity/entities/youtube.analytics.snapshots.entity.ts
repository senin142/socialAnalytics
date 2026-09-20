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
	tableName: 'YoutubeAnalyticsSnapshots',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class YoutubeAnalyticsSnapshots extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	reportType: string;

	@Column({
		type: DataType.DATEONLY,
		allowNull: false
	})
	snapshotDate: string;

	@Column({
		type: DataType.DATEONLY,
		allowNull: true
	})
	rangeStartDate: string | null;

	@Column({
		type: DataType.DATEONLY,
		allowNull: true
	})
	rangeEndDate: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	rawJson: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: false,
		defaultValue: DataType.NOW
	})
	fetchedAt: Date;
}
