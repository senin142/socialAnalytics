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
	tableName: 'SocialStatsIngestionControl',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class SocialStatsIngestionControl extends Model {
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

	/** null = applies to every jobType on this platform. */
	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	jobType: string | null;

	@Column({
		type: DataType.BOOLEAN,
		allowNull: false,
		defaultValue: false
	})
	paused: boolean;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	reason: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	pausedBy: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	pausedAt: Date | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	resumedAt: Date | null;
}
