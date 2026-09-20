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
	tableName: 'LinkedinPageStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class LinkedinPageStats extends Model {
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
		type: DataType.DATEONLY,
		allowNull: false
	})
	statDate: string;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	allPageViews: number;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	desktopPageViews: number;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	mobilePageViews: number;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	careersPageViews: number;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	uniquePageViews: number | null;

	@Column({
		type: DataType.DATE,
		allowNull: false,
		defaultValue: DataType.NOW
	})
	fetchedAt: Date;
}
