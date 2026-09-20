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
	tableName: 'YoutubeVideoGeoStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class YoutubeVideoGeoStats extends Model {
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
		type: DataType.STRING,
		allowNull: false
	})
	videoId: string;

	@Column({
		type: DataType.DATEONLY,
		allowNull: false
	})
	date: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	countryCode: string;

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
