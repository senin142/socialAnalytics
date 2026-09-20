import {
	AutoIncrement,
	Column,
	DataType,
	Model,
	PrimaryKey,
	Table,
	Unique
} from 'sequelize-typescript';

// Stories are ephemeral (gone after 24h) and keyed by their own id space, not a stable
// page-post/media id — so unlike every other content table in this module this is keyed by
// storyId + capturedAt rather than upserted onto one row per content item. Metrics grow over
// the story's lifetime (views/reach climb as it's seen), so each poll writes a new row instead
// of overwriting the previous capture.
// Facebook page stories were probed live 2026-09-18 (see METRICS_BACKLOG.txt item 2) and are
// confirmed blocked at the Graph API level for this token/app across 3 API versions — this
// table only ever holds Instagram rows for now.
@Table({
	tableName: 'MetaInstagramStoryStats',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class MetaInstagramStoryStats extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	storyId: string;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	instagramId: string;

	@Column({
		type: DataType.STRING,
		allowNull: true
	})
	mediaType: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	permalink: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	postedAt: Date | null;

	@Column({
		type: DataType.DATE,
		allowNull: false
	})
	capturedAt: Date;

	// Metric set confirmed live 2026-09-18 against v25.0: taps_forward/taps_back/exits from
	// the original backlog note no longer exist as separate metrics — Meta folded them into
	// the single "navigation" aggregate. impressions is also gone (deprecated since v22.0,
	// same pattern as Facebook's page_impressions retirement).
	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	reach: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	views: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	replies: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	navigation: string | null;

	@Column({
		type: DataType.BIGINT,
		allowNull: true
	})
	totalInteractions: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	rawJson: string | null;
}
