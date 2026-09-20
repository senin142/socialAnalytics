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
	tableName: 'MetaVideoGeoStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class MetaVideoGeoStats extends Model {
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

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	assetType: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	assetId: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	assetTitle: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	geoType: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	geoKey: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	geoName: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	metric: string;

	@Column({
		type: DataType.BIGINT,
		allowNull: false
	})
	value: string;

	@Column({
		type: DataType.DATEONLY,
		allowNull: true
	})
	startDate: string | null;

	@Column({
		type: DataType.DATEONLY,
		allowNull: true
	})
	endDate: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: false,
		defaultValue: DataType.NOW
	})
	fetchedAt: Date;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	rawJson: string | null;
}
