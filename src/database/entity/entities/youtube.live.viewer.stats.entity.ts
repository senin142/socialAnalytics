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
	tableName: 'YoutubeLiveViewerStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true,
	// The 2-minute sampler dedups against the last 90s of samples for the active stream and
	// the timeline reads a (channel, video) range ordered by sampledAt — both hit this.
	// Existing databases got it via CREATE INDEX CONCURRENTLY under the same name.
	indexes: [
		{
			name: 'idx_ylvs_video_sampled',
			fields: ['channelId', 'videoId', 'sampledAt']
		}
	]
})
export class YoutubeLiveViewerStats extends Model {
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
		type: DataType.STRING,
		allowNull: true
	})
	title: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: false,
		defaultValue: '0'
	})
	concurrentViewers: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	lifeTimeViews: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	likes: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	comments: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	liveBroadcastContent: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	broadcastStatus: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	actualStartTime: Date | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	actualEndTime: Date | null;

	@Column({
		type: DataType.DATE,
		allowNull: false,
		defaultValue: DataType.NOW
	})
	sampledAt: Date;
}
