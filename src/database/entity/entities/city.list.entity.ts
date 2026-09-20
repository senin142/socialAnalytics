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
 * Offline city gazetteer, the city-level counterpart of CountryList. Seeded from the
 * GeoNames `cities15000` export (every place with population >= 15,000, CC BY 4.0,
 * https://www.geonames.org) by `tools/migration/import-geonames-cities.js`; nothing at
 * runtime writes to it. Social platforms report audience cities as bare names
 * ("Hama, Hama Governorate"), and this is what turns those into map coordinates
 * without calling a geocoding API.
 */
@Table({
	tableName: 'CityList',
	freezeTableName: true,
	paranoid: false,
	timestamps: true,
	indexes: [
		{ name: 'idx_citylist_name_key', fields: ['nameKey'] },
		{ name: 'idx_citylist_country', fields: ['countryCode'] }
	]
})
export class CityList extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.INTEGER,
		allowNull: false,
		unique: true
	})
	geonameId: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	name: string;

	/** GeoNames' ASCII transliteration of `name` — what most external sources send. */
	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	asciiName: string;

	/** Lower-cased, diacritic-stripped `asciiName`: the exact-match lookup key. */
	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	nameKey: string;

	/** Pipe-delimited, lower-cased alternate spellings ("|latakia|lattakia|al ladhiqiyah|"),
	 * for the fallback lookup when the primary name doesn't match. */
	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	alternateNames: string | null;

	@Column({
		type: DataType.STRING(2),
		allowNull: false
	})
	countryCode: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	admin1Code: string | null;

	/** First-level administrative region name ("Hama", "Giza", "Hawalli") — what platforms
	 * append after the city name, and the tie-breaker between same-named cities. */
	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	admin1Name: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	population: string;

	@Column({
		type: DataType.DECIMAL(10, 6),
		allowNull: false
	})
	latitude: string;

	@Column({
		type: DataType.DECIMAL(10, 6),
		allowNull: false
	})
	longitude: string;
}
