import { CityList } from '../../entity';

export const CityListProvider = [
  {
    provide: 'CITY_LIST_REPOSITORY',
    useValue: CityList,
  },
];
