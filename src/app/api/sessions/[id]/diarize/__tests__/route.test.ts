import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/database', () => ({ db: {} }));
vi.mock('@/lib/permissions', () => ({ requireSessionAccess: vi.fn() }));

import { db } from '@/services/database';
import { requireSessionAccess } from '@/lib/permissions';
import { POST } from '../route';

function req(id: string) {
  const r = new Request(`http://localhost/api/sessions/${id}/diarize`, {
    method: 'POST',
  }) as unknown as Parameters<typeof POST>[0];
  return { req: r, ctx: { params: Promise.resolve({ id }) } };
}

const blobUpload = { id: 'up_1', status: 'uploaded', storage: 'blob' };

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(db as unknown as Record<string, unknown>, {
    getSessionById: vi.fn(async () => ({
      id: 'sess_1',
      diarizationStatus: 'none',
      upload: blobUpload,
    })),
    createOnDemandDiarizationJob: vi.fn(async () => ({ id: 'job_1' })),
  });
  vi.mocked(requireSessionAccess).mockResolvedValue({
    ok: true,
    userId: 'u1',
    role: 'owner',
    campaignId: 'camp_1',
  } as never);
});

describe('POST /api/sessions/[id]/diarize', () => {
  it('enqueues a job when audio is present and idle', async () => {
    const { req: r, ctx } = req('sess_1');
    const res = await POST(r, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, jobId: 'job_1' });
    expect(db.createOnDemandDiarizationJob).toHaveBeenCalledWith('sess_1');
  });

  it('passes through the access denial', async () => {
    vi.mocked(requireSessionAccess).mockResolvedValueOnce({
      ok: false,
      response: new Response('no', { status: 404 }),
    } as never);
    const { req: r, ctx } = req('sess_1');
    expect((await POST(r, ctx)).status).toBe(404);
    expect(db.createOnDemandDiarizationJob).not.toHaveBeenCalled();
  });

  it('404s when the session is missing', async () => {
    (db.getSessionById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const { req: r, ctx } = req('sess_x');
    expect((await POST(r, ctx)).status).toBe(404);
  });

  it('409s when diarization is already running', async () => {
    (db.getSessionById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'sess_1',
      diarizationStatus: 'running',
      upload: blobUpload,
    });
    const { req: r, ctx } = req('sess_1');
    expect((await POST(r, ctx)).status).toBe(409);
    expect(db.createOnDemandDiarizationJob).not.toHaveBeenCalled();
  });

  it('409s when the atomic enqueue loses a race (returns null)', async () => {
    (db.createOnDemandDiarizationJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const { req: r, ctx } = req('sess_1');
    expect((await POST(r, ctx)).status).toBe(409);
  });

  it('409s when the audio has been purged', async () => {
    (db.getSessionById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'sess_1',
      diarizationStatus: 'none',
      upload: { id: 'up_1', status: 'cleaned', storage: 'blob' },
    });
    const { req: r, ctx } = req('sess_1');
    expect((await POST(r, ctx)).status).toBe(409);
  });

  it('409s when there is no upload', async () => {
    (db.getSessionById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'sess_1',
      diarizationStatus: 'none',
      upload: null,
    });
    const { req: r, ctx } = req('sess_1');
    expect((await POST(r, ctx)).status).toBe(409);
  });

  it('409s for a non-blob upload', async () => {
    (db.getSessionById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'sess_1',
      diarizationStatus: 'none',
      upload: { id: 'up_1', status: 'uploaded', storage: 'local' },
    });
    const { req: r, ctx } = req('sess_1');
    expect((await POST(r, ctx)).status).toBe(409);
  });
});
