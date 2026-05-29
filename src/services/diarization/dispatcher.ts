import { logger } from '@/lib/logger';
import type { DiarizationJob, GamingSession, Upload } from '@prisma/client';
import type { AciClient } from './aci';
import { evaluateDispatch } from './budget';
import type { DispatchConfig } from './config';
import type { StorageService } from '@/services/storage/types';

/** No callback within this window after the container terminates => failed. */
export const CALLBACK_GRACE_MS = 5 * 60 * 1000;
/** Permanently fail a job after this many dispatch attempts. */
export const MAX_ATTEMPTS = 3;

type QueuedJob = DiarizationJob & {
  session: GamingSession & { upload: Upload | null };
};

/** Narrowed DB surface the dispatcher needs — keeps tests free of Prisma. */
export interface DispatcherDb {
  countRunningDiarizationJobs(): Promise<number>;
  countRunningDiarizationJobsByCampaign(campaignId: string): Promise<number>;
  sumDiarizationCostSince(since: Date): Promise<number>;
  listQueuedDiarizationJobs(limit?: number): Promise<QueuedJob[]>;
  claimDiarizationJobForDispatch(jobId: string): Promise<boolean>;
  updateDiarizationJob(
    jobId: string,
    data: {
      aciResourceId?: string | null;
      region?: string | null;
      costEstimateUsd?: number | null;
    },
  ): Promise<DiarizationJob>;
  revertDiarizationJobToQueued(jobId: string): Promise<void>;
  failDiarizationJob(jobId: string, errorMessage: string): Promise<void>;
  listRunningDiarizationJobsWithAci(): Promise<DiarizationJob[]>;
}

export interface DispatcherDeps {
  db: DispatcherDb;
  aci: AciClient;
  storage: Pick<StorageService, 'issueReadUrl'>;
  config: DispatchConfig;
  now?: () => Date;
}

function startOfDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Launch GPU containers for queued diarization jobs, subject to concurrency and
 * budget caps. Each candidate is claimed atomically (queued -> running) before
 * any external call so concurrent ticks can't double-dispatch; if launch fails
 * the claim is reverted (or the job permanently failed once attempts run out).
 */
export async function dispatchQueuedJobs(deps: DispatcherDeps): Promise<void> {
  const { db, storage, config } = deps;
  const now = deps.now ?? (() => new Date());

  const queued = await db.listQueuedDiarizationJobs();
  if (queued.length === 0) return;

  let running = await db.countRunningDiarizationJobs();
  let dailySpendUsd = await db.sumDiarizationCostSince(startOfDay(now()));
  // Track per-campaign running counts as we dispatch within this tick.
  const campaignRunning = new Map<string, number>();

  for (const job of queued) {
    const campaignId = job.session.campaignId;
    if (!campaignRunning.has(campaignId)) {
      campaignRunning.set(
        campaignId,
        await db.countRunningDiarizationJobsByCampaign(campaignId),
      );
    }

    const decision = evaluateDispatch(
      {
        running,
        runningInCampaign: campaignRunning.get(campaignId)!,
        dailySpendUsd,
        bypassBudget: job.bypassBudget,
      },
      config,
    );
    if (!decision.allowed) {
      // System-wide cap reached => no later job will fit either; stop early.
      if (decision.reason === 'system_concurrency' || decision.reason === 'budget') break;
      continue; // per-campaign cap: skip this job, others may still dispatch.
    }

    const upload = job.session.upload;
    if (!upload || upload.storage !== 'blob') {
      await db.failDiarizationJob(
        job.id,
        'Session audio is not stored in blob storage; diarization requires a blob-backed upload.',
      );
      continue;
    }

    if (!(await db.claimDiarizationJobForDispatch(job.id))) {
      continue; // lost the race to another tick.
    }

    try {
      const { url: audioUrl } = await storage.issueReadUrl(upload.path, config.sasTtlMs);
      const callbackUrl = `${config.callbackBaseUrl}/api/diarization/callback/${job.id}`;

      const aciResourceId = await launchInFirstAcceptingRegion(deps, job, {
        audioUrl,
        callbackUrl,
      });

      await db.updateDiarizationJob(job.id, {
        aciResourceId,
        costEstimateUsd: config.estimatedCostUsd,
      });

      running += 1;
      campaignRunning.set(campaignId, campaignRunning.get(campaignId)! + 1);
      dailySpendUsd += config.estimatedCostUsd;
      logger.info('Diarization container dispatched', { jobId: job.id, aciResourceId });
    } catch (err) {
      logger.error('Diarization dispatch failed', err as Error, { jobId: job.id });
      if (job.attemptCount + 1 >= MAX_ATTEMPTS) {
        await db.failDiarizationJob(
          job.id,
          `Dispatch failed after ${MAX_ATTEMPTS} attempts: ${(err as Error).message}`,
        );
      } else {
        await db.revertDiarizationJobToQueued(job.id);
      }
    }
  }
}

/**
 * Try each configured region in order, returning the resource id of the first
 * region that accepts the container group. Best-effort cleanup of a partially
 * created group on a per-region failure. Throws if no region accepts.
 */
async function launchInFirstAcceptingRegion(
  deps: DispatcherDeps,
  job: QueuedJob,
  urls: { audioUrl: string; callbackUrl: string },
): Promise<string> {
  const { aci, config } = deps;
  let lastError: unknown;
  for (const region of config.regions) {
    try {
      const { aciResourceId } = await aci.create({
        jobId: job.id,
        region,
        audioUrl: urls.audioUrl,
        callbackUrl: urls.callbackUrl,
        hmacSecret: job.hmacSecret,
      });
      // Persist region eagerly so cleanup can find the group even if the
      // follow-up cost/resource update below were to fail.
      await deps.db.updateDiarizationJob(job.id, { region, aciResourceId });
      return aciResourceId;
    } catch (err) {
      lastError = err;
      logger.warn('Diarization region rejected container; trying next', {
        jobId: job.id,
        region,
        error: (err as Error).message,
      });
    }
  }
  throw new Error(
    `No region accepted the diarization container (tried ${config.regions.join(', ')}): ${
      (lastError as Error)?.message ?? 'unknown error'
    }`,
  );
}

/**
 * Reconcile running jobs against their ACI container state. A terminated
 * container whose callback already landed (status flipped to completed by the
 * callback route) won't appear here; if a terminated container has NOT produced
 * a callback within the grace window it's treated as a failure. Either way the
 * container group is deleted to stop GPU billing.
 */
export async function reconcileRunningJobs(deps: DispatcherDeps): Promise<void> {
  const { db, aci } = deps;
  const now = deps.now ?? (() => new Date());

  const running = await db.listRunningDiarizationJobsWithAci();
  for (const job of running) {
    if (!job.aciResourceId) continue;
    let status;
    try {
      status = await aci.getStatus(job.aciResourceId);
    } catch (err) {
      logger.error('Failed to query ACI status', err as Error, { jobId: job.id });
      continue;
    }

    if (status === 'Running') continue;

    // Terminated or NotFound: the container is done but the job is still
    // `running`, so no successful callback arrived. Enforce the grace window.
    const startedAt = job.startedAt ?? job.createdAt;
    const elapsed = now().getTime() - startedAt.getTime();
    if (elapsed < CALLBACK_GRACE_MS) continue;

    if (status !== 'NotFound') {
      await aci.delete(job.aciResourceId).catch((err) => {
        logger.error('Failed to delete terminated ACI group', err as Error, { jobId: job.id });
      });
    }

    if (job.attemptCount >= MAX_ATTEMPTS) {
      await db.failDiarizationJob(
        job.id,
        `Container terminated without a callback after ${MAX_ATTEMPTS} attempts.`,
      );
    } else {
      // Allow a retry on the next dispatch tick.
      await db.revertDiarizationJobToQueued(job.id);
    }
  }
}
