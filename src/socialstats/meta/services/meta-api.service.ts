import { Injectable, Logger } from '@nestjs/common';
import axios, {
	AxiosError,
	AxiosInstance,
	AxiosRequestConfig,
	AxiosResponse
} from 'axios';
import { MetaRateLimitService } from './meta-rate-limit.service';

@Injectable()
export class MetaApiService {
	private readonly logger = new Logger(MetaApiService.name);
	private readonly baseUrl =
		process.env.META_GRAPH_API_BASE_URL || 'https://graph.facebook.com';
	private readonly version = process.env.META_GRAPH_API_VERSION || 'v26.0';
	private readonly timeoutMs = Number(process.env.META_HTTP_TIMEOUT_MS ?? 15000);
	private readonly maxRetries = Number(process.env.META_HTTP_MAX_RETRIES ?? 2);
	private readonly retryBaseDelayMs = Number(
		process.env.META_HTTP_RETRY_BASE_DELAY_MS ?? 1000
	);
	private readonly client: AxiosInstance;

	constructor(private readonly metaRateLimitService: MetaRateLimitService) {
		this.client = axios.create({
			baseURL: this.baseUrl,
			timeout: this.timeoutMs
		});
	}

	getClientMetadata() {
		return {
			baseUrl: this.baseUrl,
			version: this.version,
			timeoutMs: this.timeoutMs,
			clientReady: Boolean(this.client)
		};
	}

	async get<T = any>(
		path: string,
		options?: {
			params?: Record<string, unknown>;
			accessToken?: string;
			versioned?: boolean;
			endpointLabel?: string;
		}
	): Promise<T> {
		const targetPath = this.resolvePath(path, options?.versioned);
		const params = {
			...(options?.params || {}),
			...(options?.accessToken ? { access_token: options.accessToken } : {})
		};
		const endpointLabel = options?.endpointLabel || path;
		await this.metaRateLimitService.assertRequestAllowed(endpointLabel);

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				const response = await this.client.get<T>(targetPath, { params });
				await this.captureUsageHeaders(
					response,
					endpointLabel,
					params.access_token ? 'tokenized_get' : 'public_get'
				);
				return response.data;
			} catch (error) {
				const source = params.access_token ? 'tokenized_get' : 'public_get';
				if (attempt < this.maxRetries && this.shouldRetryRequest(error)) {
					const retryDelayMs = this.getRetryDelayMs(attempt);
					this.logger.warn(
						`Retrying Meta API request for ${endpointLabel} [${source}] in ${retryDelayMs}ms after transient failure: ${
							(error as AxiosError)?.message || 'Unknown error'
						}`
					);
					await this.delay(retryDelayMs);
					continue;
				}

				await this.handleApiError(error, endpointLabel, source);
				throw error;
			}
		}

		throw new Error(`Meta API request retries exhausted for ${endpointLabel}`);
	}

	async requestToken<T = any>(
		params: Record<string, unknown>,
		options?: { endpointLabel?: string; config?: AxiosRequestConfig }
	): Promise<T> {
		const endpointLabel = options?.endpointLabel || '/oauth/access_token';
		await this.metaRateLimitService.assertRequestAllowed(endpointLabel);
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				const response = await this.client.get<T>('/oauth/access_token', {
					params,
					...(options?.config || {})
				});
				await this.captureUsageHeaders(
					response,
					endpointLabel,
					'token_exchange'
				);
				return response.data;
			} catch (error) {
				if (attempt < this.maxRetries && this.shouldRetryRequest(error)) {
					const retryDelayMs = this.getRetryDelayMs(attempt);
					this.logger.warn(
						`Retrying Meta token request for ${endpointLabel} in ${retryDelayMs}ms after transient failure: ${
							(error as AxiosError)?.message || 'Unknown error'
						}`
					);
					await this.delay(retryDelayMs);
					continue;
				}

				await this.handleApiError(error, endpointLabel, 'token_exchange');
				throw error;
			}
		}

		throw new Error(`Meta token request retries exhausted for ${endpointLabel}`);
	}

	private resolvePath(path: string, versioned?: boolean) {
		const normalized = path.startsWith('/') ? path : `/${path}`;
		if (versioned === false) {
			return normalized;
		}

		return `/${this.version}${normalized}`;
	}

	private async handleApiError(
		error: unknown,
		endpoint: string,
		source: string
	) {
		const axiosError = error as AxiosError<any>;
		const payload = axiosError.response?.data?.error;
		if (!payload) {
			this.logger.error(
				`Meta API request failed for ${endpoint} [${source}] with no Graph error payload: ${
					axiosError.message || 'Unknown Meta API error'
				}`
			);
			return;
		}

		const statusCode = axiosError.response?.status ?? 'unknown';
		const errorCode = payload.code ?? null;
		const errorSubcode = payload.error_subcode ?? null;
		const errorType = payload.type ? ` ${payload.type}` : '';
		const errorMessage = String(payload.message || 'Unknown Meta API error');
		this.logger.error(
			`Meta API request failed for ${endpoint} [${source}] status=${statusCode} code=${
				errorCode ?? 'unknown'
			} subcode=${errorSubcode ?? 'none'}${errorType}: ${errorMessage}`
		);

		if (!this.isRateLimitError(axiosError, payload)) {
			return;
		}

			await this.metaRateLimitService.recordRateLimitEvent({
				source,
				endpoint,
			errorCode,
			errorSubcode,
			isTransient: Boolean(payload.is_transient),
			retryAfterSeconds: this.getRetryAfterSeconds(axiosError),
			appUsage: this.stringifyHeaderValue(
				axiosError.response?.headers?.['x-app-usage']
			),
				pageUsage: this.stringifyHeaderValue(
					axiosError.response?.headers?.['x-page-usage']
				),
				rawJson: JSON.stringify({
					responseData: axiosError.response?.data ?? {},
					businessUsage: this.stringifyHeaderValue(
						axiosError.response?.headers?.['x-business-use-case-usage']
					)
				})
			});
		}

	private async captureUsageHeaders(
		response: AxiosResponse<any>,
		endpoint: string,
		source: string
	) {
		await this.metaRateLimitService.observeUsage({
			source,
			endpoint,
			appUsage: this.stringifyHeaderValue(response.headers?.['x-app-usage']),
			pageUsage: this.stringifyHeaderValue(response.headers?.['x-page-usage']),
			businessUsage: this.stringifyHeaderValue(
				response.headers?.['x-business-use-case-usage']
			)
		});
	}

	private isRateLimitError(
		error: AxiosError<any>,
		payload: Record<string, any>
	) {
		const statusCode = error.response?.status ?? null;
		const errorCode = Number(payload.code);
		const errorSubcode = Number(payload.error_subcode);
		const normalizedMessage = String(payload.message || '').toLowerCase();
		const knownRateLimitCodes = new Set([4, 17, 32, 341, 613, 80004]);
		const knownRateLimitSubcodes = new Set([2446079]);

		if (statusCode === 429) {
			return true;
		}

		if (Number.isFinite(errorCode) && knownRateLimitCodes.has(errorCode)) {
			return true;
		}

		if (
			Number.isFinite(errorSubcode) &&
			knownRateLimitSubcodes.has(errorSubcode)
		) {
			return true;
		}

		// "Please reduce the amount of data you're asking for" (code 1) is deliberately not
		// here: it means the single request was too expensive, not that we are being
		// throttled. Treating it as a rate limit set a global cooldown that then blocked the
		// caller's own smaller retry and every other endpoint for the next minute.
		return [
			'rate limit',
			'too many calls',
			'user request limit reached',
			'application request limit reached',
			'calls to this api have exceeded'
		].some((fragment) => normalizedMessage.includes(fragment));
	}

	private getRetryAfterSeconds(error: AxiosError<any>) {
		const retryAfterHeader = error.response?.headers?.['retry-after'];
		if (!retryAfterHeader) {
			return 60;
		}

		const parsed = Number(retryAfterHeader);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
	}

	private shouldRetryRequest(error: unknown) {
		const axiosError = error as AxiosError<any>;
		const statusCode = axiosError.response?.status ?? null;
		const errorCode = String((axiosError as any)?.code || '').toUpperCase();
		const message = String(axiosError.message || '').toLowerCase();

		if (statusCode === 429) {
			return true;
		}

		if (statusCode !== null && statusCode >= 500) {
			return true;
		}

		if (
			[
				'ECONNRESET',
				'ECONNABORTED',
				'ETIMEDOUT',
				'EHOSTUNREACH',
				'ENETUNREACH',
				'EAI_AGAIN',
				'ECONNREFUSED'
			].includes(errorCode)
		) {
			return true;
		}

		return (
			message.includes('timeout') ||
			message.includes('socket hang up') ||
			message.includes('network') ||
			message.includes('temporarily unavailable')
		);
	}

	private getRetryDelayMs(attempt: number) {
		return this.retryBaseDelayMs * Math.pow(2, attempt);
	}

	private async delay(ms: number) {
		await new Promise((resolve) => setTimeout(resolve, ms));
	}

	private stringifyHeaderValue(value: unknown) {
		if (typeof value === 'string') {
			return value;
		}

		if (value === undefined || value === null) {
			return null;
		}

		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
}
