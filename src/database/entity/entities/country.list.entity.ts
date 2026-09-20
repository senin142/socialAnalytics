import {
  AutoIncrement,
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
  Unique,
} from 'sequelize-typescript';

@Table({
  tableName: 'CountryList',
  freezeTableName: true,
  paranoid: false,
  timestamps: true,
})
export class CountryList extends Model {
  @PrimaryKey
  @AutoIncrement
  @Unique
  @Column
  id: number;

  @Column({
    type: DataType.STRING,
    allowNull: false,
    unique: true,
  })
  slug: string;

  @Column({
    type: DataType.STRING,
    allowNull: false,
  })
  name: string;

  @Column({
    type: DataType.STRING(2),
    allowNull: false,
    unique: true,
  })
  countryCode: string;

  @Column({
    type: DataType.DECIMAL(10, 6),
    allowNull: true,
  })
  latitude: string | null;

  @Column({
    type: DataType.DECIMAL(10, 6),
    allowNull: true,
  })
  longitude: string | null;
}
