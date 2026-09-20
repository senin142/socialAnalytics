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
	tableName: 'YoutubeVideoRetentionStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class YoutubeVideoRetentionStats extends Model {
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
		type: DataType.DECIMAL(10, 6),
		allowNull: false
	})
	elapsedVideoTimeRatio: string;

	@Column({
		type: DataType.DECIMAL(10, 6),
		allowNull: false
	})
	audienceWatchRatio: string;

	@Column({
		type: DataType.DECIMAL(10, 6),
		allowNull: true
	})
	relativeRetentionPerformance: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	audienceType: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: false
	})
	capturedAt: Date;
}
