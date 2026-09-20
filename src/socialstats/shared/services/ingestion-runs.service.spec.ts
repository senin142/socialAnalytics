import { Logger } from '@nestjs/common';
import * as os from 'os';
import { IngestionRunConflictError, IngestionRunsService } from './ingestion-runs.service';

describe('IngestionRunsService', () => {
	let service: IngestionRunsService;
	let repo: {
		sync: jest.Mock;
		create: jest.Mock;
		findAll: jest.Mock;
		findByPk: jest.Mock;
	};

	beforeEach(() => {
		jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
		jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		repo = {
			sync: jest.fn().mockResolvedValue(undefined),
			create: jest.fn(async (payload) => ({ id: 1, ...payload })),
			findAll: jest.fn().mockResolvedValue([]),
			findByPk: jest.fn()
		};
		service = new IngestionRunsService(repo as any);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	describe('onModuleInit', () => {
		it('fails runs still leased to this instance, since nothing else can finish them', async () => {
			const orphan = { id: 27649, update: jest.fn().mockResolvedValue(undefined) };
			repo.findAll.mockResolvedValue([orphan]);

			await service.onModuleInit();

			expect(repo.findAll).toHaveBeenCalledWith({
				where: {
					status: 'running',
					leasedBy: `local:${os.hostname()}`
				}
			});
			expect(orphan.update).toHaveBeenCalledWith(
				expect.objectContaining({
					status: 'failed',
					leasedBy: null,
					leaseExpiresAt: null,
					errorCode: 'ORPHANED_ON_RESTART'
				})
			);
		});

		it('never reclaims under a managed revision, where instances share a hostname', async () => {
			const orphan = { id: 27713, update: jest.fn() };
			repo.findAll.mockResolvedValue([orphan]);
			process.env.K_REVISION = 'cnbc-staging-admin-backend-00121-5xs';
			try {
				await service.onModuleInit();
			} finally {
				delete process.env.K_REVISION;
			}

			expect(repo.findAll).not.toHaveBeenCalled();
			expect(orphan.update).not.toHaveBeenCalled();
		});

		it('does not let a reclaim failure stop the module from starting', async () => {
			repo.findAll.mockRejectedValue(new Error('db down'));

			await expect(service.onModuleInit()).resolves.toBeUndefined();
			expect(repo.sync).toHaveBeenCalled();
		});
	});

	describe('createRun lease', () => {
		const baseInput = {
			platform: 'youtube',
			entityType: 'channel',
			jobType: 'live_viewers',
			runType: 'incremental',
			triggerSource: 'cron'
		};

		it('uses the default 30-minute TTL when none is given', async () => {
			const startedAt = new Date('2026-09-15T10:22:00.000Z');
			await service.createRun({ ...baseInput, startedAt });

			expect(repo.create.mock.calls[0][0].leaseExpiresAt).toEqual(
				new Date('2026-09-15T10:52:00.000Z')
			);
		});

		it('honours a per-run TTL for short, frequent jobs', async () => {
			const startedAt = new Date('2026-09-15T10:22:00.000Z');
			await service.createRun({ ...baseInput, startedAt, leaseTtlMinutes: 5 });

			expect(repo.create.mock.calls[0][0].leaseExpiresAt).toEqual(
				new Date('2026-09-15T10:27:00.000Z')
			);
		});

		it('falls back to the default for a nonsensical TTL', async () => {
			const startedAt = new Date('2026-09-15T10:22:00.000Z');
			await service.createRun({ ...baseInput, startedAt, leaseTtlMinutes: 0 });

			expect(repo.create.mock.calls[0][0].leaseExpiresAt).toEqual(
				new Date('2026-09-15T10:52:00.000Z')
			);
		});
	});

	describe('createRun cross-instance claim (postgres)', () => {
		const input = {
			platform: 'youtube',
			entityType: 'channel',
			jobType: 'live_viewers',
			runType: 'incremental',
			triggerSource: 'cron'
		};
		let transaction: { id: string };
		let sequelize: { getDialect: jest.Mock; transaction: jest.Mock; query: jest.Mock };
		let findOne: jest.Mock;

		beforeEach(() => {
			transaction = { id: 'tx' };
			sequelize = {
				getDialect: jest.fn(() => 'postgres'),
				transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(transaction)),
				query: jest.fn().mockResolvedValue(undefined)
			};
			findOne = jest.fn().mockResolvedValue(null);
			service = new IngestionRunsService({ ...repo, sequelize, findOne } as any);
		});

		it('takes the job-scoped advisory lock, re-checks, and inserts inside the transaction', async () => {
			await service.createRun(input);

			expect(sequelize.query).toHaveBeenCalledWith(
				'SELECT pg_advisory_xact_lock(hashtext(:key))',
				expect.objectContaining({
					replacements: { key: 'ingestion-run:youtube:live_viewers:channel' },
					transaction
				})
			);
			expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ transaction }));
			expect(repo.create).toHaveBeenCalledWith(expect.anything(), { transaction });
		});

		it('refuses to start when another instance already holds the job', async () => {
			findOne.mockResolvedValue({
				id: 27713,
				platform: 'youtube',
				jobType: 'live_viewers',
				leasedBy: 'cnbc-staging-admin-backend-00121-5xs:localhost'
			});

			await expect(service.createRun(input)).rejects.toBeInstanceOf(IngestionRunConflictError);
			expect(repo.create).not.toHaveBeenCalled();
		});

		it('skips the lock for runs that do not start in the running state', async () => {
			await service.createRun({ ...input, status: 'planned' });

			expect(sequelize.transaction).not.toHaveBeenCalled();
			expect(repo.create).toHaveBeenCalledTimes(1);
		});
	});

	describe('heartbeatRun', () => {
		it('keeps the TTL the run was created with instead of resetting to the default', async () => {
			const run = {
				id: 5,
				status: 'running',
				heartbeatAt: new Date('2026-09-15T10:22:00.000Z'),
				leaseExpiresAt: new Date('2026-09-15T10:27:00.000Z'),
				finishedAt: null,
				update: jest.fn().mockResolvedValue(undefined)
			};
			repo.findByPk.mockResolvedValue(run);
			const before = Date.now();

			await service.heartbeatRun(5);

			const payload = run.update.mock.calls[0][0];
			const ttlMs = payload.leaseExpiresAt.getTime() - payload.heartbeatAt.getTime();
			expect(Math.round(ttlMs / 60_000)).toBe(5);
			expect(payload.heartbeatAt.getTime()).toBeGreaterThanOrEqual(before);
		});
	});
});
