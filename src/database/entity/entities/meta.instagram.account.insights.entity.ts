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
 * One row per Instagram account, metric and calendar day — the account-level daily
 * insights (reach, profile views, website clicks, accounts engaged, views, likes, comments,
 * shares, saves, replies, follower change). These are the numbers Meta shows on the
 * "Professional dashboard"; per-media insights cannot be summed into them because reach
 * and accounts_engaged are de-duplicated across the account.
 *
 * Written by the Meta profile snapshot for a trailing window (so a day that was still
 * partial when first seen is corrected on the next pass); rows are upserted on
 * (instagramId, metric, date).
 */
@Table({
	tableName: 'MetaInstagramAccountInsights',
	freezeTableName: true,
	paranoid: false,
	timestamps: true,
	indexes: [
		{
			name: 'idx_miai_account_metric_date',
			unique: true,
			fields: ['instagramId', 'metric', 'date']
		}
	]
})
export class MetaInstagramAccountInsights extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	instagramId: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	metric: string;

	@Column({
		type: DataType.DATEONLY,
		allowNull: false
	})
	date: string;

	@Column({
		type: DataType.BIGINT,
		allowNull: false
	})
	value: string;

	/** Meta's own timestamp for the period end, kept for auditing the day boundary. */
	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	endTime: Date | null;

	@Column({
		type: DataType.DATE,
		allowNull: false
	})
	fetchedAt: Date;
}
