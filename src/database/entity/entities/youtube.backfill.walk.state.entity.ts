import {
	AutoIncrement,
	Column,
	DataType,
	Model,
	PrimaryKey,
	Table,
	Unique
} from 'sequelize-typescript';

/**
 * Single-row-per-key persisted state for YoutubeBackfillWalkService, so a server restart or
 * redeploy resumes the walk instead of silently dropping it -- same pattern as
 * MetaBackfillWalkState. `walkKey` is always 'youtube_backfill_walk' today (one walk at a
 * time), left as a column rather than hardcoding the row so a future multi-walk use case
 * doesn't need a schema change.
 */
@Table({
	tableName: 'YoutubeBackfillWalkState',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class YoutubeBackfillWalkState extends Model {
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
	walkKey: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	status: string;

	@Column({
		type: DataType.INTEGER,
		allowNull: false
	})
	chunkDays: number;

	@Column({
		type: DataType.INTEGER,
		allowNull: false
	})
	intervalMinutes: number;

	@Column({
		type: DataType.DATE,
		allowNull: false
	})
	deadline: Date;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	cursorEnd: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	lastTickAt: Date | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	lastResult: string | null;
}
