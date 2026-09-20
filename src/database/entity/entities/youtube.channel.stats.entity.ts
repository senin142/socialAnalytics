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
	tableName: 'YoutubeChannelStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class YoutubeChannelStats extends Model {
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
		allowNull: true
	})
	channelTitle: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	subscriberCount: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	viewCount: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	videoCount: string;

	@Column({
		type: DataType.DATE,
		allowNull: false,
		defaultValue: DataType.NOW
	})
	fetchedAt: Date;
}
