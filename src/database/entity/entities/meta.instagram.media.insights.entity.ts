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
	tableName: 'MetaInstagramMediaInsights',
	freezeTableName: true,
	paranoid: false,
	timestamps: true
})
export class MetaInstagramMediaInsights extends Model {
	@PrimaryKey
	@AutoIncrement
	@Unique
	@Column
	id: number;

	@Column({
		type: DataType.STRING,
		allowNull: false
	})
	mediaId: string;

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
		type: DataType.STRING,
		allowNull: true
	})
	period: string | null;

	@Column({
		type: DataType.DATE,
		allowNull: true
	})
	endTime: Date | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	value: string | null;

	@Column({
		type: DataType.TEXT,
		allowNull: true
	})
	rawJson: string | null;
}
