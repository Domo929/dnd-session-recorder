import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/database', () => ({ db: {} }));
vi.mock('@/lib/permissions', () => ({ requireSessionAccess: vi.fn() }));

import { db } from '@/services/database';
import { requireSessionAccess } from '@/lib/permissions';
import { POST } from '../route';

function req(id: string) {
  const r = new Request(`http://localhost/api/sessions/${id}/rematch`, {
    method: 'POST',
  }) as unknown as Parameters<typeof POST>[0];
  return { req: r, ctx: { params: Promise.resolve({ id }) } };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(db as unknown as Record<string, unknown>, {
    rematchSessionClusters: vi.fn(async () => ({
      linked: [{ clusterId: 'cl_1', displayLabel: 'Bruce', matchedScore: 0.91 }],
    })),
  });
  vi.mocked(requireSessionAccess).mockResolvedValue({
    ok: true,
    userId: 'u1',
    role: 'owner',
    campaignId: 'camp_1',
  } as never);
});

describe('POST /api/sessions/[id]/rematch', () => {
  it('re-runs matching and returns the linked clusters', async () => {
    const { req: r, ctx } = req('sess_1');
    const res = await POST(r, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      linked: [{ clusterId: 'cl_1', displayLabel: 'Bruce', matchedScore: 0.91 }],
    });
    expect(db.rematchSessionClusters).toHaveBeenCalledWith('sess_1', 'camp_1');
  });

  it('passes through the access denial (owner-only)', async () => {
    vi.mocked(requireSessionAccess).mockResolvedValueOnce({
      ok: false,
      response: new Response('no', { status: 404 }),
    } as never);
    const { req: r, ctx } = req('sess_1');
    expect((await POST(r, ctx)).status).toBe(404);
    expect(db.rematchSessionClusters).not.toHaveBeenCalled();
  });

  it('500s when the db call throws', async () => {
    (db.rematchSessionClusters as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const { req: r, ctx } = req('sess_1');
    expect((await POST(r, ctx)).status).toBe(500);
  });
});
