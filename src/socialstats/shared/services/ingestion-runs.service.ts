import { IngestionRuns } from '../../../database/entity';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as os from 'os';
import { Op, Transaction } from 'sequelize';

/**
 * Thrown by createRun when another run of the same job is already active. Schedulers
 * treat it as "skip this tick"; manual triggers surface it as a 409.
 */
export class IngestionRunConflictError extends Error {
	constructor(public readonly activeRun: IngestionRuns) {
		super(
			`Ingestion run ${activeRun.id} for ${activeRun.platform}/${activeRun.jobType} is already running` +
				(activeRun.leasedBy ? ` (leased by ${activeRun.leasedBy})` : '')
		);
		this.name = 'IngestionRunConflictError';
	}
}

type CreateIngestionRunInput = {
	platform: string;
	entityType: string;
	entityId?: string | null;
	jobType: string;
	runType: string;
	triggerSource: string;
	status?: string;
	attempt?: number;
	parentRunId?: number | null;
	scopeStartDate?: string | null;
	scopeEndDate?: string | null;
	cursor?: string | null;
	recordsFetched?: number;
	recordsProcessed?: number;
	recordsUpserted?: number;
	errorCode?: string | null;
	errorMessage?: string | null;
	metadata?: Record<string, unknown> | string | null;
	startedAt?: Date;
	finishedAt?: Date | null;
	/** Override the default lease TTL for jobs that finish in seconds and run every few
	 * minutes — otherwise one orphaned run blocks its own schedule for the full default. */
	leaseTtlMinutes?: number;
};

type UpdateIngestionRunInput = {
	entityType?: string;
	entityId?: string | null;
	status?: string;
	attempt?: number;
	parentRunId?: number | null;
	leasedBy?: string | null;
	leaseExpiresAt?: Date | null;
	heartbeatAt?: Date | null;
	scopeStartDate?: string | null;
	scopeEndDate?: string | null;
	cursor?: string | null;
	recordsFetched?: number;
	recordsProcessed?: number;
	recordsUpserted?: number;
	errorCode?: string | null;
	errorMessage?: string | null;
	metadata?: Record<string, unknown> | string | null;
	startedAt?: Date;
	finishedAt?: Date | null;
	instanceId?: string | null;
	revision?: string | null;
};

@Injectable()
export class IngestionRunsService implements OnModuleInit {
	private readonly logger = new Logger(IngestionRunsService.name);
	private readonly leaseTtlMinutes = Number(
		process.env.INGESTION_RUN_LEASE_TTL_MINUTES ?? 30
	);

	constructor(
		@Inject('INGESTION_RUNS_REPOSITORY')
		private readonly ingestionRunsRepo: typeof IngestionRuns
	) { }

	async onModuleInit() {
		await this.ingestionRunsRepo.sync();
		await this.reclaimOrphanedRuns();
	}

	/**
	 * A run is only ever completed/failed by the process that created it. If that process
	 * died mid-run (crash, dev-server restart), its row stays "running" until the lease
	 * lapses, and every scheduled tick of that job is skipped as "still active" meanwhile.
	 *
	 * Only safe where the owner id really identifies one process: a local dev box, where
	 * the hostname is the machine's. Under a managed revision (Cloud Run) every instance of
	 * that revision reports the same hostname, so a second instance booting would reclaim
	 * a live sibling's run as "orphaned" — there, lease expiry is the only safe recovery.
	 */
	private async reclaimOrphanedRuns() {
		if (this.getRevision()) {
			return;
		}
		try {
			const now = new Date();
			const orphanedRuns = await this.ingestionRunsRepo.findAll({
				where: {
					status: 'running',
					leasedBy: this.getLeaseOwner()
				}
			});

			for (const run of orphanedRuns) {
				await run.update({
					status: 'failed',
					finishedAt: now,
					leasedBy: null,
					leaseExpiresAt: null,
					errorCode: 'ORPHANED_ON_RESTART',
					errorMessage: 'Ingestion run was still running when its instance restarted'
				});
			}

			if (orphanedRuns.length) {
				this.logger.warn(
					`Marked ${orphanedRuns.length} ingestion run(s) orphaned by a restart of ${this.getLeaseOwner()} as failed`
				);
			}
		} catch (error: any) {
			this.logger.error(
				`Unable to reclaim orphaned ingestion runs: ${error?.message || 'Unknown error'}`
			);
		}
	}

	/**
	 * The schedulers' `findActiveRun` pre-check is not atomic with the insert, so two
	 * instances ticking in the same second both saw "nothing running" and both started
	 * (64 such pairs in two days). For a run that starts in `running` state, this is the
	 * authoritative check: a transaction-scoped Postgres advisory lock keyed on the job
	 * serialises claimants across instances, the active-run check is repeated under the
	 * lock, and only the first claimant inserts — the rest get IngestionRunConflictError.
	 * Expired leases are still ignored by that check, so a dead instance's row never
	 * blocks the next tick. Non-Postgres dialects fall back to the plain insert.
	 */
	async createRun(input: CreateIngestionRunInput) {
		const isRunning = (input.status ?? 'running') === 'running';
		const sequelize = this.ingestionRunsRepo.sequelize;
		if (!isRunning || !sequelize || sequelize.getDialect() !== 'postgres') {
			return await this.insertRun(input);
		}

		return await sequelize.transaction(async (transaction) => {
			await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
				replacements: { key: `ingestion-run:${input.platform}:${input.jobType}:${input.entityType}` },
				transaction
			});
			const activeRun = await this.findActiveRun(
				{ platform: input.platform, jobType: input.jobType, entityType: input.entityType },
				transaction
			);
			if (activeRun) {
				throw new IngestionRunConflictError(activeRun);
			}
			return await this.insertRun(input, transaction);
		});
	}

	private async insertRun(input: CreateIngestionRunInput, transaction?: Transaction) {
		const now = input.startedAt ?? new Date();
		const isRunning = (input.status ?? 'running') === 'running';

		return await this.ingestionRunsRepo.create({
			platform: input.platform,
			entityType: input.entityType,
			entityId: input.entityId ?? null,
			jobType: input.jobType,
			runType: input.runType,
			triggerSource: input.triggerSource,
			status: input.status ?? 'running',
			attempt: input.attempt ?? 1,
			parentRunId: input.parentRunId ?? null,
			leasedBy: isRunning ? this.getLeaseOwner() : null,
			leaseExpiresAt: isRunning ? this.buildLeaseExpiry(now, input.leaseTtlMinutes) : null,
			heartbeatAt: isRunning ? now : null,
			scopeStartDate: input.scopeStartDate ?? null,
			scopeEndDate: input.scopeEndDate ?? null,
			cursor: input.cursor ?? null,
			recordsFetched: input.recordsFetched ?? 0,
			recordsProcessed: input.recordsProcessed ?? 0,
			recordsUpserted: input.recordsUpserted ?? 0,
			errorCode: input.errorCode ?? null,
			errorMessage: input.errorMessage ?? null,
			metadata: this.serializeMetadata(input.metadata),
			startedAt: now,
			finishedAt: input.finishedAt ?? null,
			instanceId: this.getInstanceId(),
			revision: this.getRevision()
		}, transaction ? { transaction } : undefined);
	}

	async findActiveRun(
		options: {
			platform: string;
			jobType: string;
			entityType?: string;
			entityId?: string | null;
		},
		transaction?: Transaction
	) {
		return await this.ingestionRunsRepo.findOne({
			where: {
				platform: options.platform,
				jobType: options.jobType,
				status: 'running',
				...(options.entityType ? { entityType: options.entityType } : {}),
				...(options.entityId !== undefined ? { entityId: options.entityId ?? null } : {}),
				[Op.or]: [
					{ leaseExpiresAt: null },
					{
						leaseExpiresAt: {
							[Op.gt]: new Date()
						}
					}
				]
			},
			order: [['createdAt', 'DESC']],
			...(transaction ? { transaction } : {})
		});
	}

	async findLatestSuccessfulRun(options: {
		platform: string;
		jobType: string;
		entityType?: string;
		entityId?: string | null;
	}) {
		return await this.ingestionRunsRepo.findOne({
			where: {
				platform: options.platform,
				jobType: options.jobType,
				status: 'completed',
				...(options.entityType ? { entityType: options.entityType } : {}),
				...(options.entityId !== undefined ? { entityId: options.entityId ?? null } : {})
			},
			order: [['finishedAt', 'DESC']]
		});
	}

	async updateRun(runId: number, input: UpdateIngestionRunInput) {
		const run = await this.ingestionRunsRepo.findByPk(runId);
		if (!run) {
			this.logger.warn(`Ingestion run ${runId} not found while updating`);
			return null;
		}

		const nextStatus = input.status ?? run.status;
		const shouldHeartbeat = nextStatus === 'running';
		const finishedAt =
			input.finishedAt !== undefined
				? input.finishedAt
				: nextStatus === 'completed' || nextStatus === 'failed' || nextStatus === 'skipped'
					? new Date()
					: run.finishedAt;

		await run.update({
			...(input.entityType !== undefined ? { entityType: input.entityType } : {}),
			...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
			...(input.status !== undefined ? { status: input.status } : {}),
			...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
			...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
			leasedBy:
				input.leasedBy !== undefined
					? input.leasedBy
					: shouldHeartbeat
						? this.getLeaseOwner()
						: null,
			leaseExpiresAt:
				input.leaseExpiresAt !== undefined
					? input.leaseExpiresAt
					: shouldHeartbeat
						? this.buildLeaseExpiry(new Date(), this.resolveLeaseTtlMinutes(run))
						: null,
			heartbeatAt:
				input.heartbeatAt !== undefined
					? input.heartbeatAt
					: shouldHeartbeat
						? new Date()
						: run.heartbeatAt,
			...(input.scopeStartDate !== undefined ? { scopeStartDate: input.scopeStartDate } : {}),
			...(input.scopeEndDate !== undefined ? { scopeEndDate: input.scopeEndDate } : {}),
			...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
			...(input.recordsFetched !== undefined ? { recordsFetched: input.recordsFetched } : {}),
			...(input.recordsProcessed !== undefined
				? { recordsProcessed: input.recordsProcessed }
				: {}),
			...(input.recordsUpserted !== undefined
				? { recordsUpserted: input.recordsUpserted }
				: {}),
			...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
			...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
			...(input.metadata !== undefined
				? { metadata: this.serializeMetadata(input.metadata) }
				: {}),
			...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
			...(finishedAt !== undefined ? { finishedAt } : {}),
			instanceId: input.instanceId ?? this.getInstanceId(),
			revision: input.revision ?? this.getRevision()
		});

		return run;
	}

	async heartbeatRun(runId: number, input?: Omit<UpdateIngestionRunInput, 'heartbeatAt' | 'leaseExpiresAt' | 'leasedBy'>) {
		return await this.updateRun(runId, {
			...(input || {}),
			status: input?.status ?? 'running'
		});
	}

	async completeRun(runId: number, input?: Omit<UpdateIngestionRunInput, 'status' | 'finishedAt' | 'leaseExpiresAt'>) {
		return await this.updateRun(runId, {
			...(input || {}),
			status: 'completed',
			finishedAt: new Date(),
			leaseExpiresAt: null,
			leasedBy: null
		});
	}

	async failRun(
		runId: number,
		error: unknown,
		input?: Omit<UpdateIngestionRunInput, 'status' | 'finishedAt' | 'errorCode' | 'errorMessage' | 'leaseExpiresAt'>
	) {
		const message = this.getErrorMessage(error);
		return await this.updateRun(runId, {
			...(input || {}),
			status: 'failed',
			finishedAt: new Date(),
			leaseExpiresAt: null,
			leasedBy: null,
			errorCode: this.inferErrorCode(message),
			errorMessage: message
		});
	}

	async markExpiredRunningRunsFailed() {
		const now = new Date();
		const expiredRuns = await this.ingestionRunsRepo.findAll({
			where: {
				status: 'running',
				leaseExpiresAt: {
					[Op.lt]: now
				}
			}
		});

		for (const run of expiredRuns) {
			await run.update({
				status: 'failed',
				finishedAt: now,
				leasedBy: null,
				leaseExpiresAt: null,
				errorCode: 'LEASE_EXPIRED',
				errorMessage: 'Ingestion run lease expired before completion'
			});
		}

		return expiredRuns.length;
	}

	getErrorMessage(error: unknown) {
		const typedError = error as any;
		return (
			typedError?.response?.data?.error?.message ||
			typedError?.response?.data?.message ||
			typedError?.message ||
			'Unknown ingestion error'
		);
	}

	inferErrorCode(message: string) {
		const normalized = String(message || '').toLowerCase();
		if (
			normalized.includes('quotaexceeded') ||
			normalized.includes('dailylimitexceeded') ||
			normalized.includes('quota budget') ||
			(normalized.includes('quota') && !normalized.includes('quotation'))
		) {
			return 'QUOTA_EXCEEDED';
		}
		if (
			normalized.includes('rate limit') ||
			normalized.includes('rate_limit') ||
			normalized.includes('usage_threshold') ||
			normalized.includes('too many calls') ||
			normalized.includes('retry after')
		) {
			return 'RATE_LIMIT';
		}
		if (
			normalized.includes('credential') ||
			normalized.includes('token') ||
			normalized.includes('expired') ||
			normalized.includes('revoked') ||
			normalized.includes('invalid grant')
		) {
			return 'CREDENTIAL_ERROR';
		}
		if (
			normalized.includes('permission') ||
			normalized.includes('forbidden') ||
			normalized.includes('not allowed')
		) {
			return 'PERMISSION_DENIED';
		}
		if (
			normalized.includes('timeout') ||
			normalized.includes('econnreset') ||
			normalized.includes('network')
		) {
			return 'TRANSIENT_NETWORK';
		}
		if (
			normalized.includes('service_unavailable') ||
			normalized.includes('service unavailable') ||
			normalized.includes('bad gateway') ||
			normalized.includes('gateway timeout')
		) {
			return 'SERVICE_UNAVAILABLE';
		}
		return 'UNKNOWN';
	}

	private serializeMetadata(metadata?: Record<string, unknown> | string | null) {
		if (metadata === undefined) {
			return null;
		}
		if (metadata === null) {
			return null;
		}
		if (typeof metadata === 'string') {
			return metadata;
		}

		try {
			return JSON.stringify(metadata);
		} catch {
			return JSON.stringify({ serializationError: true });
		}
	}

	private getInstanceId() {
		return os.hostname();
	}

	private getRevision() {
		return process.env.K_REVISION || null;
	}

	private getLeaseOwner() {
		return `${this.getRevision() || 'local'}:${this.getInstanceId()}`;
	}

	private buildLeaseExpiry(baseDate = new Date(), ttlMinutes = this.leaseTtlMinutes) {
		const effectiveTtl =
			Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : this.leaseTtlMinutes;
		return new Date(baseDate.getTime() + effectiveTtl * 60_000);
	}

	/** The TTL a run was created with isn't stored, but it is recoverable: every lease is
	 * stamped as heartbeatAt + TTL, so the gap between the two is the TTL. Heartbeats use
	 * this so a run created with a short lease keeps it instead of growing to the default. */
	private resolveLeaseTtlMinutes(run: { leaseExpiresAt?: Date | null; heartbeatAt?: Date | null }) {
		if (!run.leaseExpiresAt || !run.heartbeatAt) {
			return this.leaseTtlMinutes;
		}
		const ttlMinutes =
			(new Date(run.leaseExpiresAt).getTime() - new Date(run.heartbeatAt).getTime()) / 60_000;
		return ttlMinutes > 0 ? Math.round(ttlMinutes) : this.leaseTtlMinutes;
	}
}
