import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CALLBACK_GRACE_MS,
  MAX_ATTEMPTS,
  dispatchQueuedJobs,
  reconcileRunningJobs,
  type DispatcherDb,
  type DispatcherDeps,
} from '../dispatcher';
import type { AciClient } from '../aci';
import type { DispatchConfig } from '../config';
import type { DiarizationJob } from '@prisma/client';

type QueuedJob = Awaited<ReturnType<DispatcherDb['listQueuedDiarizationJobs']>>[number];

const config: DispatchConfig = {
  maxDailyUsd: 5,
  maxConcurrent: 3,
  maxPerCampaign: 1,
  regions: ['centralus', 'westus2', 'eastus2'],
  image: 'img',
  estimatedCostUsd: 0.3,
  callbackBaseUrl: 'https://app.example.com',
  sasTtlMs: 7_200_000,
  subscriptionId: 'sub',
  resourceGroup: 'rg',
  gpuSku: 'T4',
  huggingFaceToken: null,
};

interface JobOpts {
  id?: string;
  attemptCount?: number;
  campaignId?: string;
  uploadStorage?: string;
  bypassBudget?: boolean;
}

function makeJob(opts: JobOpts = {}): QueuedJob {
  const job = {
    id: opts.id ?? 'job-1',
    sessionId: 'sess-1',
    status: 'running',
    aciResourceId: null,
    hmacSecret: 'secret',
    attemptCount: opts.attemptCount ?? 0,
    region: null,
    bypassBudget: opts.bypassBudget ?? false,
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
    costEstimateUsd: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    session: {
      id: 'sess-1',
      campaignId: opts.campaignId ?? 'camp-1',
      upload: { id: 'up-1', path: 'uploads/u/a.m4a', storage: opts.uploadStorage ?? 'blob' },
    },
  };
  return job as unknown as QueuedJob;
}

function makeDb(queued: QueuedJob[]): DispatcherDb {
  return {
    countRunningDiarizationJobs: vi.fn().mockResolvedValue(0),
    countRunningDiarizationJobsByCampaign: vi.fn().mockResolvedValue(0),
    sumDiarizationCostSince: vi.fn().mockResolvedValue(0),
    listQueuedDiarizationJobs: vi.fn().mockResolvedValue(queued),
    claimDiarizationJobForDispatch: vi.fn().mockResolvedValue(true),
    updateDiarizationJob: vi.fn().mockResolvedValue({} as DiarizationJob),
    revertDiarizationJobToQueued: vi.fn().mockResolvedValue(undefined),
    failDiarizationJob: vi.fn().mockResolvedValue(undefined),
    listRunningDiarizationJobsWithAci: vi.fn().mockResolvedValue([]),
  };
}

function makeAci(overrides: Partial<AciClient> = {}): AciClient {
  return {
    create: vi.fn().mockResolvedValue({ aciResourceId: '/aci/job-1' }),
    getStatus: vi.fn().mockResolvedValue('Running'),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const storage = {
  issueReadUrl: vi.fn().mockResolvedValue({ url: 'https://sas', expiresAt: new Date() }),
};

beforeEach(() => {
  storage.issueReadUrl.mockClear();
});

describe('dispatchQueuedJobs', () => {
  it('claims, mints a read SAS, creates the container, and records aci/cost', async () => {
    const db = makeDb([makeJob()]);
    const aci = makeAci();
    const deps: DispatcherDeps = { db, aci, storage, config };

    await dispatchQueuedJobs(deps);

    expect(db.claimDiarizationJobForDispatch).toHaveBeenCalledWith('job-1');
    expect(storage.issueReadUrl).toHaveBeenCalledWith('uploads/u/a.m4a', config.sasTtlMs);
    expect(aci.create).toHaveBeenCalledTimes(1);
    expect(aci.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        region: 'centralus',
        callbackUrl: 'https://app.example.com/api/diarization/callback/job-1',
        hmacSecret: 'secret',
      }),
    );
    expect(db.updateDiarizationJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ aciResourceId: '/aci/job-1', costEstimateUsd: 0.3 }),
    );
    expect(db.failDiarizationJob).not.toHaveBeenCalled();
  });

  it('falls through regions until one accepts', async () => {
    const db = makeDb([makeJob()]);
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('centralus full'))
      .mockRejectedValueOnce(new Error('westus2 full'))
      .mockResolvedValueOnce({ aciResourceId: '/aci/eastus2' });
    const aci = makeAci({ create });
    const deps: DispatcherDeps = { db, aci, storage, config };

    await dispatchQueuedJobs(deps);

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2][0].region).toBe('eastus2');
    expect(db.revertDiarizationJobToQueued).not.toHaveBeenCalled();
  });

  it('reverts to queued when no region accepts (attempts remain)', async () => {
    const db = makeDb([makeJob({ attemptCount: 0 })]);
    const aci = makeAci({ create: vi.fn().mockRejectedValue(new Error('no capacity')) });
    const deps: DispatcherDeps = { db, aci, storage, config };

    await dispatchQueuedJobs(deps);

    expect(db.revertDiarizationJobToQueued).toHaveBeenCalledWith('job-1');
    expect(db.failDiarizationJob).not.toHaveBeenCalled();
  });

  it('permanently fails when dispatch fails on the final attempt', async () => {
    const db = makeDb([makeJob({ attemptCount: MAX_ATTEMPTS - 1 })]);
    const aci = makeAci({ create: vi.fn().mockRejectedValue(new Error('no capacity')) });
    const deps: DispatcherDeps = { db, aci, storage, config };

    await dispatchQueuedJobs(deps);

    expect(db.failDiarizationJob).toHaveBeenCalledWith(
      'job-1',
      expect.stringContaining('Dispatch failed'),
    );
    expect(db.revertDiarizationJobToQueued).not.toHaveBeenCalled();
  });

  it('fails a job whose upload is not blob-backed without launching anything', async () => {
    const db = makeDb([makeJob({ uploadStorage: 'local' })]);
    const aci = makeAci();
    const deps: DispatcherDeps = { db, aci, storage, config };

    await dispatchQueuedJobs(deps);

    expect(db.failDiarizationJob).toHaveBeenCalledWith(
      'job-1',
      expect.stringContaining('blob storage'),
    );
    expect(db.claimDiarizationJobForDispatch).not.toHaveBeenCalled();
    expect(aci.create).not.toHaveBeenCalled();
  });

  it('stops dispatching once the system concurrency cap is hit', async () => {
    const db = makeDb([makeJob({ id: 'a' }), makeJob({ id: 'b', campaignId: 'camp-2' })]);
    vi.mocked(db.countRunningDiarizationJobs).mockResolvedValue(3);
    const aci = makeAci();
    const deps: DispatcherDeps = { db, aci, storage, config };

    await dispatchQueuedJobs(deps);

    expect(db.claimDiarizationJobForDispatch).not.toHaveBeenCalled();
    expect(aci.create).not.toHaveBeenCalled();
  });

  it('skips a job over the per-campaign cap but still dispatches another campaign', async () => {
    const db = makeDb([
      makeJob({ id: 'a', campaignId: 'camp-1' }),
      makeJob({ id: 'b', campaignId: 'camp-2' }),
    ]);
    vi.mocked(db.countRunningDiarizationJobsByCampaign).mockImplementation((c: string) =>
      Promise.resolve(c === 'camp-1' ? 1 : 0),
    );
    const aci = makeAci();
    const deps: DispatcherDeps = { db, aci, storage, config };

    await dispatchQueuedJobs(deps);

    expect(db.claimDiarizationJobForDispatch).toHaveBeenCalledTimes(1);
    expect(db.claimDiarizationJobForDispatch).toHaveBeenCalledWith('b');
  });

  it('skips a job it loses the claim race for', async () => {
    const db = makeDb([makeJob()]);
    vi.mocked(db.claimDiarizationJobForDispatch).mockResolvedValue(false);
    const aci = makeAci();
    const deps: DispatcherDeps = { db, aci, storage, config };

    await dispatchQueuedJobs(deps);

    expect(aci.create).not.toHaveBeenCalled();
    expect(db.updateDiarizationJob).not.toHaveBeenCalled();
  });
});

describe('reconcileRunningJobs', () => {
  const runningJob = (attemptCount = 1): DiarizationJob =>
    ({
      id: 'job-1',
      sessionId: 'sess-1',
      status: 'running',
      aciResourceId: '/aci/job-1',
      attemptCount,
      startedAt: new Date('2026-06-01T00:00:00Z'),
      createdAt: new Date('2026-06-01T00:00:00Z'),
    }) as unknown as DiarizationJob;

  const base = new Date('2026-06-01T00:00:00Z').getTime();

  it('leaves a still-running container alone', async () => {
    const db = makeDb([]);
    vi.mocked(db.listRunningDiarizationJobsWithAci).mockResolvedValue([runningJob()]);
    const aci = makeAci({ getStatus: vi.fn().mockResolvedValue('Running') });
    const now = () => new Date(base + 60 * 60 * 1000);

    await reconcileRunningJobs({ db, aci, storage, config, now });

    expect(aci.delete).not.toHaveBeenCalled();
    expect(db.failDiarizationJob).not.toHaveBeenCalled();
    expect(db.revertDiarizationJobToQueued).not.toHaveBeenCalled();
  });

  it('waits out the grace window before acting on a terminated container', async () => {
    const db = makeDb([]);
    vi.mocked(db.listRunningDiarizationJobsWithAci).mockResolvedValue([runningJob()]);
    const aci = makeAci({ getStatus: vi.fn().mockResolvedValue('Terminated') });
    const now = () => new Date(base + CALLBACK_GRACE_MS - 1000);

    await reconcileRunningJobs({ db, aci, storage, config, now });

    expect(aci.delete).not.toHaveBeenCalled();
    expect(db.revertDiarizationJobToQueued).not.toHaveBeenCalled();
  });

  it('deletes the group and requeues a terminated callback-less job with attempts left', async () => {
    const db = makeDb([]);
    vi.mocked(db.listRunningDiarizationJobsWithAci).mockResolvedValue([runningJob(1)]);
    const aci = makeAci({ getStatus: vi.fn().mockResolvedValue('Terminated') });
    const now = () => new Date(base + CALLBACK_GRACE_MS + 1000);

    await reconcileRunningJobs({ db, aci, storage, config, now });

    expect(aci.delete).toHaveBeenCalledWith('/aci/job-1');
    expect(db.revertDiarizationJobToQueued).toHaveBeenCalledWith('job-1');
    expect(db.failDiarizationJob).not.toHaveBeenCalled();
  });

  it('permanently fails after the attempt cap', async () => {
    const db = makeDb([]);
    vi.mocked(db.listRunningDiarizationJobsWithAci).mockResolvedValue([runningJob(MAX_ATTEMPTS)]);
    const aci = makeAci({ getStatus: vi.fn().mockResolvedValue('Terminated') });
    const now = () => new Date(base + CALLBACK_GRACE_MS + 1000);

    await reconcileRunningJobs({ db, aci, storage, config, now });

    expect(aci.delete).toHaveBeenCalledWith('/aci/job-1');
    expect(db.failDiarizationJob).toHaveBeenCalledWith(
      'job-1',
      expect.stringContaining('without a callback'),
    );
  });

  it('does not call delete for a NotFound group but still resolves the job', async () => {
    const db = makeDb([]);
    vi.mocked(db.listRunningDiarizationJobsWithAci).mockResolvedValue([runningJob(MAX_ATTEMPTS)]);
    const aci = makeAci({ getStatus: vi.fn().mockResolvedValue('NotFound') });
    const now = () => new Date(base + CALLBACK_GRACE_MS + 1000);

    await reconcileRunningJobs({ db, aci, storage, config, now });

    expect(aci.delete).not.toHaveBeenCalled();
    expect(db.failDiarizationJob).toHaveBeenCalled();
  });
});
