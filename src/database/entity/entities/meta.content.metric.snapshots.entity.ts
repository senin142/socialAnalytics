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
	tableName: 'MetaContentMetricSnapshots',
	freezeTableName: true,
	paranoid: false,
	timestamps: true,
	// Every content snapshot does one lookup per post on (platform, assetId, snapshotDate);
	// without this the table (100k+ rows) was sequentially scanned thousands of times a run.
	// sync() only creates indexes on a brand-new table — existing databases got this via
	// CREATE INDEX CONCURRENTLY under the same name.
	indexes: [
		{
			name: 'idx_mcms_asset_day',
			fields: ['platform', 'assetId', 'snapshotDate']
		}
	]
})
export class MetaContentMetricSnapshots extends Model {
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
	accountId: string | null;

	@Column({
		type: DataType.DATEONLY,
		allowNull: false
	})
	snapshotDate: string;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	likes: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	comments: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	shares: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	saved: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	reach: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	impressions: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	engagement: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	interactions: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	views: string | null;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	engagementSource: string | null;

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
