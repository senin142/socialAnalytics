import { SocialStatsIngestionControl } from '../../../database/entity';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';

export type PauseState = {
	paused: boolean;
	scope: 'job' | 'platform' | null;
	reason: string | null;
	pausedBy: string | null;
	pausedAt: Date | null;
};

/**
 * Lets an admin stop a scheduled ingestion job (or a whole platform) at runtime, without a
 * redeploy, and have every cron tick respect it going forward. Deliberately does not try to
 * cancel a run that's already in flight — it only gates the *next* scheduled attempt, so a
 * currently-running job always finishes cleanly instead of being torn down mid-write.
 */
@Injectable()
export class IngestionControlService implements OnModuleInit {
	// Wildcard row (jobType: null) for "this whole platform" reuses the DB's own null
	// semantics as the sentinel, matching how findOne/where already treats it.
	private static readonly PLATFORM_WILDCARD = null;

	constructor(
		@Inject('SOCIAL_STATS_INGESTION_CONTROL_REPOSITORY')
		private readonly ingestionControlRepo: typeof SocialStatsIngestionControl
	) { }

	async onModuleInit() {
		await this.ingestionControlRepo.sync();
	}

	async pause(options: { platform: string; jobType?: string | null; reason?: string; pausedBy?: string }) {
		const jobType = options.jobType ?? IngestionControlService.PLATFORM_WILDCARD;
		const existing = await this.ingestionControlRepo.findOne({
			where: { platform: options.platform, jobType }
		});

		const payload = {
			platform: options.platform,
			jobType,
			paused: true,
			reason: options.reason ?? null,
			pausedBy: options.pausedBy ?? null,
			pausedAt: new Date(),
			resumedAt: null
		};

		if (existing) {
			await existing.update(payload);
			return existing;
		}
		return await this.ingestionControlRepo.create(payload);
	}

	async resume(options: { platform: string; jobType?: string | null }) {
		const jobType = options.jobType ?? IngestionControlService.PLATFORM_WILDCARD;
		const existing = await this.ingestionControlRepo.findOne({
			where: { platform: options.platform, jobType }
		});

		if (!existing) {
			return null;
		}

		await existing.update({ paused: false, resumedAt: new Date() });
		return existing;
	}

	/** Checked by every cron before it starts a run. Platform-wide pause takes precedence
	 * over (and doesn't need) a per-job row — pausing "meta" pauses every meta job without
	 * having to also write a row per job type. */
	async isPaused(platform: string, jobType: string): Promise<PauseState> {
		const [jobRow, platformRow] = await Promise.all([
			this.ingestionControlRepo.findOne({ where: { platform, jobType } }),
			this.ingestionControlRepo.findOne({
				where: { platform, jobType: IngestionControlService.PLATFORM_WILDCARD }
			})
		]);

		if (platformRow?.paused) {
			return {
				paused: true,
				scope: 'platform',
				reason: platformRow.reason,
				pausedBy: platformRow.pausedBy,
				pausedAt: platformRow.pausedAt
			};
		}

		if (jobRow?.paused) {
			return {
				paused: true,
				scope: 'job',
				reason: jobRow.reason,
				pausedBy: jobRow.pausedBy,
				pausedAt: jobRow.pausedAt
			};
		}

		return { paused: false, scope: null, reason: null, pausedBy: null, pausedAt: null };
	}

	async getAllControls(platform?: string) {
		const rows = await this.ingestionControlRepo.findAll({
			where: platform ? { platform } : undefined,
			order: [
				['platform', 'ASC'],
				['jobType', 'ASC']
			],
			raw: true
		});

		return (rows as any[]).map((row) => ({
			platform: row.platform,
			jobType: row.jobType,
			scope: row.jobType === null ? 'platform' : 'job',
			paused: row.paused,
			reason: row.reason,
			pausedBy: row.pausedBy,
			pausedAt: row.pausedAt,
			resumedAt: row.resumedAt
		}));
	}
}
