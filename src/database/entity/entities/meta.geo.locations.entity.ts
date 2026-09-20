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
	tableName: 'MetaGeoLocations',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class MetaGeoLocations extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

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
		allowNull: false
	})
	geoName: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	countryCode: string | null;

	@Column({
		type: DataType.DECIMAL(10, 6),
		allowNull: true
	})
	latitude: string | null;

	@Column({
		type: DataType.DECIMAL(10, 6),
		allowNull: true
	})
	longitude: string | null;
}
