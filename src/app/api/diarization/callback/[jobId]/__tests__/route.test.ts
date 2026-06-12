import { createHmac } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/database', () => ({ db: {} }));
vi.mock('@/services/storage', () => ({ getStorageService: vi.fn() }));
vi.mock('@/services/diarization', () => ({
  generateClusterSnippet: vi.fn(),
  SNIPPET_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
}));

import { db } from '@/services/database';
import { getStorageService } from '@/services/storage';
import { generateClusterSnippet } from '@/services/diarization';
import { serializeEmbedding, EMBEDDING_DIM } from '@/lib/voiceFingerprint';
import { POST } from '../route';

const SECRET = 'a'.repeat(64); // 32 bytes hex

/** A unit-norm embedding pointing along a single axis (cosine 1.0 with itself). */
function axisEmbedding(axis: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  v[axis % EMBEDDING_DIM] = 1;
  return v;
}

function sign(body: string): string {
  return createHmac('sha256', Buffer.from(SECRET, 'hex')).update(body).digest('hex');
}

function callbackRequest(jobId: string, body: string, signature: string | null) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signature !== null) headers['X-Signature'] = signature;
  const req = new Request(`http://localhost/api/diarization/callback/${jobId}`, {
    method: 'POST',
    headers,
    body,
  }) as unknown as Parameters<typeof POST>[0];
  return { req, ctx: { params: Promise.resolve({ jobId }) } };
}

const job = {
  id: 'job_1',
  sessionId: 'sess_1',
  status: 'queued',
  hmacSecret: SECRET,
  session: { id: 'sess_1', campaignId: 'camp_1', uploadId: 'upl_1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(db as unknown as Record<string, unknown>, {
    getDiarizationJobById: vi.fn(async () => job),
    getCampaignFingerprints: vi.fn(async () => [
      { voiceSampleId: 'vs_1', memberId: 'mem_1', label: 'Alice', embeddings: [axisEmbedding(0)] },
    ]),
    getUploadById: vi.fn(async () => ({ id: 'upl_1', path: 'uploads/u/x.m4a' })),
    upsertSpeakerCluster: vi.fn(async (d: { clusterIdx: number }) => ({ id: `cl_${d.clusterIdx}` })),
    addLearnedExemplar: vi.fn(async () => {}),
    completeDiarizationJob: vi.fn(async () => {}),
    claimDiarizationJobForCallback: vi.fn(async () => true),
    setSessionDiarizationStatus: vi.fn(async () => {}),
    updateDiarizationJob: vi.fn(async () => job),
  });
  vi.mocked(getStorageService).mockReturnValue({
    materializeToTempFile: vi.fn(async () => '/tmp/source.opus'),
  } as never);
  vi.mocked(generateClusterSnippet).mockResolvedValue('voice-samples/clusters/sess_1/1.opus');
});

function payloadWith(clusters: unknown[], segments: unknown[]) {
  return JSON.stringify({ clusters, segments });
}

const matchedCluster = {
  clusterIdx: 0,
  embeddingCentroid: serializeEmbedding(axisEmbedding(0)).toString('base64'),
  segmentCount: 5,
  totalDurationMs: 12000,
  representativeStartMs: 1000,
  representativeEndMs: 4000,
};
const unknownCluster = {
  clusterIdx: 1,
  embeddingCentroid: serializeEmbedding(axisEmbedding(50)).toString('base64'),
  segmentCount: 3,
  totalDurationMs: 8000,
  representativeStartMs: 20000,
  representativeEndMs: 23000,
};

describe('POST /api/diarization/callback/[jobId]', () => {
  it('404 when the job is unknown', async () => {
    vi.mocked(db.getDiarizationJobById).mockResolvedValueOnce(null as never);
    const body = payloadWith([matchedCluster], [{ startMs: 0, endMs: 1000, text: 'hi', clusterIdx: 0 }]);
    const { req, ctx } = callbackRequest('nope', body, sign(body));
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it('401 when the signature is missing or wrong', async () => {
    const body = payloadWith([matchedCluster], [{ startMs: 0, endMs: 1000, text: 'hi', clusterIdx: 0 }]);
    const { req, ctx } = callbackRequest('job_1', body, 'deadbeef');
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    expect(db.upsertSpeakerCluster).not.toHaveBeenCalled();
  });

  it('409 when the job is already finished (replay guard)', async () => {
    vi.mocked(db.getDiarizationJobById).mockResolvedValueOnce({ ...job, status: 'completed' } as never);
    const body = payloadWith([matchedCluster], [{ startMs: 0, endMs: 1000, text: 'hi', clusterIdx: 0 }]);
    const { req, ctx } = callbackRequest('job_1', body, sign(body));
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    expect(db.upsertSpeakerCluster).not.toHaveBeenCalled();
    expect(db.completeDiarizationJob).not.toHaveBeenCalled();
  });

  it('409 when a concurrent callback already claimed the job (TOCTOU guard)', async () => {
    vi.mocked(db.claimDiarizationJobForCallback).mockResolvedValueOnce(false as never);
    const body = payloadWith([matchedCluster], [{ startMs: 0, endMs: 1000, text: 'hi', clusterIdx: 0 }]);
    const { req, ctx } = callbackRequest('job_1', body, sign(body));
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    expect(db.upsertSpeakerCluster).not.toHaveBeenCalled();
    expect(db.completeDiarizationJob).not.toHaveBeenCalled();
  });

  it('400 on an invalid payload', async () => {
    const body = JSON.stringify({ clusters: [], segments: [] });
    const { req, ctx } = callbackRequest('job_1', body, sign(body));
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('matches a high-confidence cluster and learns from it', async () => {
    const body = payloadWith(
      [matchedCluster],
      [{ startMs: 0, endMs: 2000, text: 'hello there', clusterIdx: 0, confidence: 0.9 }],
    );
    const { req, ctx } = callbackRequest('job_1', body, sign(body));
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);

    const upsert = vi.mocked(db.upsertSpeakerCluster).mock.calls[0][0];
    expect(upsert.displayLabel).toBe('Alice');
    expect(upsert.voiceSampleId).toBe('vs_1');
    expect(upsert.matchConfidence).toBe('high');

    expect(db.addLearnedExemplar).toHaveBeenCalledTimes(1);
    const learned = vi.mocked(db.addLearnedExemplar).mock.calls[0][0];
    expect(learned.voiceSampleId).toBe('vs_1');
    expect(learned.source).toBe('auto_matched');
    expect(learned.sourceSessionId).toBe('sess_1');

    expect(db.completeDiarizationJob).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      jobId: 'job_1',
      uploadId: 'upl_1',
      rows: [
        { startTime: 0, endTime: 2, text: 'hello there', confidence: 0.9, speakerClusterId: 'cl_0' },
      ],
    });
  });

  it('labels an unknown cluster, generates a snippet, and never learns from it', async () => {
    const body = payloadWith(
      [unknownCluster],
      [{ startMs: 20000, endMs: 22000, text: 'mystery voice', clusterIdx: 1 }],
    );
    const { req, ctx } = callbackRequest('job_1', body, sign(body));
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);

    const upsert = vi.mocked(db.upsertSpeakerCluster).mock.calls[0][0];
    expect(upsert.displayLabel).toBe('DM (Unknown #1)');
    expect(upsert.voiceSampleId).toBeNull();
    expect(upsert.matchConfidence).toBe('none');
    expect(upsert.snippetBlobPath).toBe('voice-samples/clusters/sess_1/1.opus');
    expect(upsert.snippetExpiresAt).toBeInstanceOf(Date);

    expect(generateClusterSnippet).toHaveBeenCalledTimes(1);
    expect(db.addLearnedExemplar).not.toHaveBeenCalled();
  });
});
