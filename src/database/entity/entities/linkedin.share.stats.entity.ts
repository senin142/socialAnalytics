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
	tableName: 'LinkedinShareStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class LinkedinShareStats extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	organizationUrn: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	shareUrn: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	ugcPostUrn: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	impressionCount: number;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	uniqueImpressionsCount: number | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	clickCount: number;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	likeCount: number;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	commentCount: number;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	shareCount: number;

	@Column({
		type: DataType.DECIMAL(10, 6),
		allowNull: true
	})
	engagement: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: false,
		defaultValue: DataType.NOW
	})
	capturedAt: Date;
}
