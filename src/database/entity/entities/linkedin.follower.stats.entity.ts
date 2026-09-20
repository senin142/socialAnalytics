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
 * One row per (facet, facetKey) pair from organizationalEntityFollowerStatistics — facet is
 * one of the 7 LinkedIn professional-demographic breakdowns (geoCountry, geo, industry,
 * function, seniority, staffCountRange, associationType) and facetKey is the raw URN/enum
 * LinkedIn returns for that facet (e.g. "urn:li:geo:103644278", "SIZE_1"). Kept as a single
 * generalized table (like MetaAudienceGeoStats/MetaAudienceDemographicStats) rather than one
 * column per facet, since LinkedIn can add/change facets without a schema change here.
 */
@Table({
	tableName: 'LinkedinFollowerStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class LinkedinFollowerStats extends Model {
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
		allowNull: false
	})
	facet: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	facetKey: string;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	organicFollowerCount: number;

	@Column({
		type: DataType.BIGINT,
		allowNull: false,
		defaultValue: 0
	})
	paidFollowerCount: number;

	@Column({
		type: DataType.DATE,
		allowNull: false,
		defaultValue: DataType.NOW
	})
	capturedAt: Date;
}
