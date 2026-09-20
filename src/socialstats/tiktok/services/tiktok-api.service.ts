import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { TiktokAuthService } from './tiktok-auth.service';
import { TiktokQuotaService } from './tiktok-quota.service';

const API_BASE_URL = 'https://open.tiktokapis.com/v2';

/**
 * Thin wrapper around TikTok's v2 Display API.
 *
 * The one thing that must not be got wrong here: TikTok answers almost every failure with
 * HTTP 200 and an `error` object in the body — `error.code === 'ok'` is the only reliable
 * success signal. Treating a 200 as success (as one would for LinkedIn or Meta) silently
 * writes empty analytics rows, so unwrap() throws on any non-'ok' code and tags the thrown
 * error with `tiktokErrorCode` for callers that need to distinguish a missing scope from a
 * dead token from a throttle.
 *
 * Request shapes are not uniform either: /v2/user/info/ is a GET with `fields` in the query
 * string, while /v2/video/list/ is a POST that *also* takes `fields` in the query string and
 * puts pagination in a JSON body. Both forms are exposed rather than hidden behind one
 * method, since collapsing them would obscure which is which at the call site.
 */
@Injectable()
export class TiktokApiService {
	private readonly logger = new Logger(TiktokApiService.name);
	private readonly requestTimeoutMs = Number(process.env.TIKTOK_HTTP_TIMEOUT_MS ?? 15000);
	private readonly client: AxiosInstance;

	constructor(
		private readonly tiktokAuthService: TiktokAuthService,
		private readonly tiktokQuotaService: TiktokQuotaService
	) {
		this.client = axios.create({ baseURL: API_BASE_URL, timeout: this.requestTimeoutMs });
	}

	async get<T = any>(path: string, options: { fields: string[]; endpointLabel: string }): Promise<T> {
		return await this.request<T>('get', path, {
			fields: options.fields,
			endpointLabel: options.endpointLabel
		});
	}

	async post<T = any>(
		path: string,
		options: { fields?: string[]; body?: Record<string, unknown>; endpointLabel: string }
	): Promise<T> {
		return await this.request<T>('post', path, options);
	}

	getErrorMessage(error: any) {
		return (
			error?.response?.data?.error?.message ||
			error?.response?.data?.error_description ||
			error?.message ||
			'Unknown TikTok API error'
		);
	}

	/** TikTok reports an un-granted scope as a normal response, not an auth failure. */
	isScopeError(error: any) {
		return error?.tiktokErrorCode === 'scope_not_authorized';
	}

	private async request<T>(
		method: 'get' | 'post',
		path: string,
		options: { fields?: string[]; body?: Record<string, unknown>; endpointLabel: string }
	): Promise<T> {
		await this.tiktokQuotaService.assertBudgetAvailable(options.endpointLabel);
		const { accessToken } = await this.tiktokAuthService.getAccessToken();

		const headers = {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json'
		};
		const params = options.fields?.length ? { fields: options.fields.join(',') } : undefined;

		const send = async () =>
			method === 'get'
				? await this.client.get(path, { params, headers })
				: await this.client.post(path, options.body ?? {}, { params, headers });

		try {
			const response = await send();
			await this.tiktokQuotaService.recordUsage(options.endpointLabel);
			return this.unwrap<T>(response.data, options.endpointLabel);
		} catch (err: any) {
			const status = err?.response?.status;
			const throttled = status === 429 || err?.tiktokErrorCode === 'rate_limit_exceeded';
			if (throttled || status === 503) {
				this.logger.warn(`${options.endpointLabel} was throttled or unavailable, retrying once after backoff`);
				await new Promise((resolve) => setTimeout(resolve, 2000));
				const retryResponse = await send();
				await this.tiktokQuotaService.recordUsage(options.endpointLabel);
				return this.unwrap<T>(retryResponse.data, options.endpointLabel);
			}
			throw err;
		}
	}

	private unwrap<T>(payload: any, endpointLabel: string): T {
		const code = payload?.error?.code;
		if (code && code !== 'ok') {
			const error: any = new Error(
				`${payload.error.message || code} (endpoint: ${endpointLabel}, log_id: ${payload.error.log_id ?? 'n/a'})`
			);
			// log_id is the only handle TikTok support will act on, so it is kept on the error
			// rather than only written to a log line that may be sampled away.
			error.tiktokErrorCode = code;
			error.tiktokLogId = payload.error.log_id;
			throw error;
		}
		return payload?.data as T;
	}
}
