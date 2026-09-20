import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { LinkedinAuthService } from './linkedin-auth.service';
import { LinkedinQuotaService } from './linkedin-quota.service';

const REST_BASE_URL = 'https://api.linkedin.com/rest';

/**
 * Thin GET wrapper around LinkedIn's versioned REST API (`/rest/...`, distinct from the
 * older unversioned `/v2/...` surface this module intentionally does not use). Every request
 * needs three headers LinkedIn treats as mandatory: `Authorization`, `LinkedIn-Version`
 * (YYYYMM — LinkedinAuthService.resolveApiVersion()) and `X-Restli-Protocol-Version: 2.0.0`.
 * Also retries once on a transient 429/5xx like the YouTube/Meta services in this module do,
 * and records usage against LinkedinQuotaService's daily budget either way.
 */
@Injectable()
export class LinkedinApiService {
	private readonly logger = new Logger(LinkedinApiService.name);
	private readonly requestTimeoutMs = Number(process.env.LINKEDIN_HTTP_TIMEOUT_MS ?? 15000);
	private readonly client: AxiosInstance;

	constructor(
		private readonly linkedinAuthService: LinkedinAuthService,
		private readonly linkedinQuotaService: LinkedinQuotaService
	) {
		this.client = axios.create({ baseURL: REST_BASE_URL, timeout: this.requestTimeoutMs });
	}

	/** Restli 2.0 nested-object query param, e.g. buildTimeIntervalsParam(...) for `timeIntervals`. */
	buildTimeIntervalsParam(startMs: number, endMs: number | null, granularity: 'DAY' | 'WEEK' | 'MONTH') {
		const range = endMs ? `start:${startMs},end:${endMs}` : `start:${startMs}`;
		return `(timeRange:(${range}),timeGranularityType:${granularity})`;
	}

	async get<T = any>(
		path: string,
		options: { params: Record<string, unknown>; endpointLabel: string }
	): Promise<T> {
		await this.linkedinQuotaService.assertBudgetAvailable(options.endpointLabel);
		const { accessToken } = await this.linkedinAuthService.getAccessToken();

		const headers = {
			Authorization: `Bearer ${accessToken}`,
			'LinkedIn-Version': this.linkedinAuthService.resolveApiVersion(),
			'X-Restli-Protocol-Version': '2.0.0',
			'Content-Type': 'application/json'
		};

		try {
			const response = await this.client.get<T>(path, { params: options.params, headers });
			await this.linkedinQuotaService.recordUsage(options.endpointLabel);
			return response.data;
		} catch (err: any) {
			const status = err?.response?.status;
			if (status === 429 || status === 503) {
				this.logger.warn(`${options.endpointLabel} hit ${status}, retrying once after backoff`);
				await new Promise((resolve) => setTimeout(resolve, 1500));
				const retryResponse = await this.client.get<T>(path, { params: options.params, headers });
				await this.linkedinQuotaService.recordUsage(options.endpointLabel);
				return retryResponse.data;
			}
			throw err;
		}
	}

	getErrorMessage(error: any) {
		return (
			error?.response?.data?.message ||
			error?.response?.data?.error_description ||
			error?.message ||
			'Unknown LinkedIn API error'
		);
	}
}
