import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/database', () => ({ db: {} }));
vi.mock('@/lib/permissions', () => ({ requireSessionAccess: vi.fn() }));
vi.mock('@/services/storage/createUploadFromBlob', () => ({
  createUploadFromBlob: vi.fn(),
  UploadCompletionError: class UploadCompletionError extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { db } from '@/services/database';
import { requireSessionAccess } from '@/lib/permissions';
import {
  createUploadFromBlob,
  UploadCompletionError,
} from '@/services/storage/createUploadFromBlob';
import { POST } from '../route';

function req(id: string, body: unknown) {
  const r = new Request(`http://localhost/api/sessions/${id}/reupload-audio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
  return { req: r, ctx: { params: Promise.resolve({ id }) } };
}

const validBody = {
  blobPath: 'users/u1/abc.opus',
  originalName: 'session.opus',
  mimetype: 'audio/ogg',
  size: 12345,
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(db as unknown as Record<string, unknown>, {
    getSessionById: vi.fn(async () => ({ id: 'sess_1' })),
    updateSession: vi.fn(async () => ({})),
  });
  vi.mocked(requireSessionAccess).mockResolvedValue({
    ok: true,
    userId: 'u1',
    role: 'owner',
    campaignId: 'camp_1',
  } as never);
  vi.mocked(createUploadFromBlob).mockResolvedValue({ id: 'up_new' } as never);
});

describe('POST /api/sessions/[id]/reupload-audio', () => {
  it('creates an upload and points the session at it', async () => {
    const { req: r, ctx } = req('sess_1', validBody);
    const res = await POST(r, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, uploadId: 'up_new' });
    expect(createUploadFromBlob).toHaveBeenCalledWith('u1', validBody);
    expect(db.updateSession).toHaveBeenCalledWith('sess_1', { uploadId: 'up_new' });
  });

  it('passes through the access denial', async () => {
    vi.mocked(requireSessionAccess).mockResolvedValueOnce({
      ok: false,
      response: new Response('no', { status: 404 }),
    } as never);
    const { req: r, ctx } = req('sess_1', validBody);
    expect((await POST(r, ctx)).status).toBe(404);
    expect(createUploadFromBlob).not.toHaveBeenCalled();
  });

  it('404s when the session is missing', async () => {
    (db.getSessionById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const { req: r, ctx } = req('sess_x', validBody);
    expect((await POST(r, ctx)).status).toBe(404);
  });

  it('400s on a missing field', async () => {
    const { req: r, ctx } = req('sess_1', { blobPath: 'x' });
    expect((await POST(r, ctx)).status).toBe(400);
    expect(createUploadFromBlob).not.toHaveBeenCalled();
  });

  it('maps an UploadCompletionError to its status', async () => {
    vi.mocked(createUploadFromBlob).mockRejectedValueOnce(
      new UploadCompletionError(422, 'size mismatch'),
    );
    const { req: r, ctx } = req('sess_1', validBody);
    const res = await POST(r, ctx);
    expect(res.status).toBe(422);
    expect(db.updateSession).not.toHaveBeenCalled();
  });
});
