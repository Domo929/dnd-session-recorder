import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('@/services/database', () => ({
  db: {},
  ClusterAlreadyTaggedError: class ClusterAlreadyTaggedError extends Error {},
}));
vi.mock('@/lib/permissions', () => ({ requireCampaignAccess: vi.fn() }));

import { db, ClusterAlreadyTaggedError } from '@/services/database';
import { requireCampaignAccess } from '@/lib/permissions';
import { POST } from '../route';

function request(clusterId: string, body: unknown) {
  const req = new Request(`http://localhost/api/clusters/${clusterId}/tag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
  return { req, ctx: { params: Promise.resolve({ clusterId }) } };
}

const cluster = {
  id: 'cl_1',
  sessionId: 'sess_1',
  session: { campaignId: 'camp_1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(db as unknown as Record<string, unknown>, {
    getClusterForTagging: vi.fn(async () => cluster),
    getMemberId: vi.fn(async () => 'mem_1'),
    tagClusterWithExistingVoice: vi.fn(async () => {}),
    tagClusterWithNewName: vi.fn(async () => ({ affectedSessionIds: ['sess_1', 'sess_2'] })),
  });
  vi.mocked(requireCampaignAccess).mockResolvedValue({
    ok: true,
    userId: 'user_1',
    role: 'owner',
  } as never);
});

describe('POST /api/clusters/[clusterId]/tag', () => {
  it('404s when the cluster is missing', async () => {
    (db.getClusterForTagging as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const { req, ctx } = request('cl_x', { name: 'Bob' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it('rejects the access denial response', async () => {
    const denied = { ok: false, response: new Response('no', { status: 403 }) };
    vi.mocked(requireCampaignAccess).mockResolvedValueOnce(denied as never);
    const { req, ctx } = request('cl_1', { name: 'Bob' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
  });

  it('rejects a body with both voiceSampleId and name', async () => {
    const { req, ctx } = request('cl_1', { voiceSampleId: 'vs_1', name: 'Bob' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(db.tagClusterWithExistingVoice).not.toHaveBeenCalled();
    expect(db.tagClusterWithNewName).not.toHaveBeenCalled();
  });

  it('rejects an empty body (neither field)', async () => {
    const { req, ctx } = request('cl_1', {});
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('links to an existing voice', async () => {
    const { req, ctx } = request('cl_1', { voiceSampleId: 'vs_9' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(db.tagClusterWithExistingVoice).toHaveBeenCalledWith('cl_1', 'vs_9', 'sess_1');
    expect(await res.json()).toEqual({ ok: true, affectedSessionIds: ['sess_1'] });
  });

  it('names a new voice and runs the cascade', async () => {
    const { req, ctx } = request('cl_1', { name: 'Bartender' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(db.tagClusterWithNewName).toHaveBeenCalledWith({
      clusterId: 'cl_1',
      name: 'Bartender',
      memberId: 'mem_1',
      campaignId: 'camp_1',
    });
    expect(await res.json()).toEqual({ ok: true, affectedSessionIds: ['sess_1', 'sess_2'] });
  });

  it('maps a unique-constraint violation to 409', async () => {
    (db.tagClusterWithNewName as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    const { req, ctx } = request('cl_1', { name: 'Bartender' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
  });

  it('maps a lost tag race (already tagged) to 409', async () => {
    (db.tagClusterWithNewName as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ClusterAlreadyTaggedError('cl_1'),
    );
    const { req, ctx } = request('cl_1', { name: 'Bartender' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
  });
});
