import {
	AutoIncrement,
	Column,
	DataType,
	Model,
	PrimaryKey,
	Table,
	Unique
} from 'sequelize-typescript';

export enum YoutubeGeoDeviceDimensionType {
	COUNTRY = 'COUNTRY',
	DEVICE_TYPE = 'DEVICE_TYPE',
	OPERATING_SYSTEM = 'OPERATING_SYSTEM'
}

@Table({
	tableName: 'YoutubeGeoDeviceStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class YoutubeGeoDeviceStats extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	channelId: string;

	@Column({
		type: DataType.DATEONLY,
		allowNull: false
	})
	date: string;

	@Column({
		type: DataType.ENUM('COUNTRY', 'DEVICE_TYPE', 'OPERATING_SYSTEM'),
		allowNull: false
	})
	dimensionType: YoutubeGeoDeviceDimensionType;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	dimensionValue: string;

	@Column({
		type: DataType.BIGINT,
		allowNull: false
	})
	views: string;

	@Column({
		type: DataType.BIGINT,
		allowNull: false
	})
	estimatedMinutesWatched: string;
}
