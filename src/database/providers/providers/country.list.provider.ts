import { CountryList } from '../../entity';

export const CountryListProvider = [
  {
    provide: 'COUNTRY_LIST_REPOSITORY',
    useValue: CountryList,
  },
];
