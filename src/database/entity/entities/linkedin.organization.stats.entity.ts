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
	tableName: 'LinkedinOrganizationStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class LinkedinOrganizationStats extends Model {
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
	organizationName: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	followerCount: number | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	totalPageViews: number | null;

	@Column({
		type: DataType.DATE,
		allowNull: false,
		defaultValue: DataType.NOW
	})
	fetchedAt: Date;
}
