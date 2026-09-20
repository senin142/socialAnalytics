import {
	MetaGeoLocations,
	MetaVideoGeoStats
} from '../../../database/entity';
import { getName as getCountryName } from 'country-list';
import { Inject, Injectable } from '@nestjs/common';

type VideoGeoQuery = {
	platform?: string;
	assetId?: string;
	metric?: string;
	geoType?: string;
	startDate?: string;
	endDate?: string;
};

@Injectable()
export class MetaGeoService {
	constructor(
		@Inject('META_VIDEO_GEO_STATS_REPOSITORY')
		private readonly metaVideoGeoStatsRepo: typeof MetaVideoGeoStats,
		@Inject('META_GEO_LOCATIONS_REPOSITORY')
		private readonly metaGeoLocationsRepo: typeof MetaGeoLocations
	) { }

	async getVideoHotspot(query: VideoGeoQuery) {
		const rows = await this.getGeoRows(query);
		const locations = await this.metaGeoLocationsRepo.findAll({
			where: query.geoType ? { geoType: query.geoType } : undefined,
			raw: true
		});
		const locationMap = new Map(
			locations.map((location) => [
				`${location.geoType}:${location.geoKey}`,
				location
			])
		);

		return {
			statusCode: 200,
			message: 'Meta video geo hotspot fetched successfully',
			data: {
				platform: query.platform ?? null,
				assetId: query.assetId ?? null,
				metric: query.metric ?? 'views',
				geoType: query.geoType ?? 'country',
				startDate: query.startDate ?? null,
				endDate: query.endDate ?? null,
				points: rows.map((row) => {
					const location = locationMap.get(`${row.geoType}:${row.geoKey}`);
					return {
						geoKey: row.geoKey,
						geoName: this.resolveGeoDisplayName(
							row.geoKey,
							row.geoType,
							location?.geoName,
							row.geoName
						),
						lat: location?.latitude ?? null,
						lng: location?.longitude ?? null,
						value: row.value,
						assetId: row.assetId,
						assetTitle: row.assetTitle
					};
				})
			}
		};
	}

	async getVideoGeoTable(query: VideoGeoQuery) {
		const rows = await this.getGeoRows(query);
		const locations = await this.metaGeoLocationsRepo.findAll({
			where: query.geoType ? { geoType: query.geoType } : undefined,
			raw: true
		});
		const locationMap = new Map(
			locations.map((location) => [
				`${location.geoType}:${location.geoKey}`,
				location
			])
		);
		return {
			statusCode: 200,
			message: 'Meta video geo table fetched successfully',
			data: rows.map((row) => {
				const location = locationMap.get(`${row.geoType}:${row.geoKey}`);
				return {
					...row,
					geoName: this.resolveGeoDisplayName(
						row.geoKey,
						row.geoType,
						location?.geoName,
						row.geoName
					)
				};
			})
		};
	}

	private async getGeoRows(query: VideoGeoQuery) {
		return await this.metaVideoGeoStatsRepo.findAll({
			where: {
				...(query.platform ? { platform: query.platform } : {}),
				...(query.assetId ? { assetId: query.assetId } : {}),
				...(query.metric ? { metric: query.metric } : {}),
				...(query.geoType ? { geoType: query.geoType } : {}),
				...(query.startDate ? { startDate: query.startDate } : {}),
				...(query.endDate ? { endDate: query.endDate } : {})
			},
			order: [['updatedAt', 'DESC']],
			raw: true
		});
	}

	private resolveGeoDisplayName(
		geoKey?: string,
		geoType?: string,
		locationGeoName?: string | null,
		rowGeoName?: string | null
	) {
		const normalizedGeoKey = String(geoKey || '').trim();
		const preferredLocationName = String(locationGeoName || '').trim();
		if (preferredLocationName && preferredLocationName.toUpperCase() !== normalizedGeoKey.toUpperCase()) {
			return preferredLocationName;
		}

		if (String(geoType || '').toLowerCase() === 'country') {
			const countryName = getCountryName(normalizedGeoKey.toUpperCase());
			if (countryName) {
				return countryName;
			}
		}

		const normalizedRowGeoName = String(rowGeoName || '').trim();
		if (normalizedRowGeoName) {
			return normalizedRowGeoName;
		}

		return normalizedGeoKey || null;
	}
}
