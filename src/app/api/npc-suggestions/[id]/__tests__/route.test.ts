import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/database', () => ({
  db: {},
  ClusterAlreadyTaggedError: class ClusterAlreadyTaggedError extends Error {},
}));
vi.mock('@/lib/permissions', () => ({ requireCampaignAccess: vi.fn() }));

import { db } from '@/services/database';
import { requireCampaignAccess } from '@/lib/permissions';
import { POST } from '../route';

function request(id: string, body: unknown) {
  const req = new Request(`http://localhost/api/npc-suggestions/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
  return { req, ctx: { params: Promise.resolve({ id }) } };
}

const suggestion = {
  id: 'sg_1',
  clusterId: 'cl_1',
  suggestedName: 'Innkeeper',
  status: 'pending',
  session: { campaignId: 'camp_1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(db as unknown as Record<string, unknown>, {
    getNpcSuggestionById: vi.fn(async () => suggestion),
    getMemberId: vi.fn(async () => 'mem_1'),
    resolveNpcSuggestion: vi.fn(async () => true),
    tagClusterWithNewName: vi.fn(async () => ({ affectedSessionIds: ['sess_1'] })),
  });
  vi.mocked(requireCampaignAccess).mockResolvedValue({
    ok: true,
    userId: 'user_1',
    role: 'owner',
  } as never);
});

describe('POST /api/npc-suggestions/[id]', () => {
  it('404s when the suggestion is missing', async () => {
    (db.getNpcSuggestionById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const { req, ctx } = request('sg_x', { action: 'reject' });
    expect((await POST(req, ctx)).status).toBe(404);
  });

  it('409s when already resolved', async () => {
    (db.getNpcSuggestionById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...suggestion,
      status: 'accepted',
    });
    const { req, ctx } = request('sg_1', { action: 'reject' });
    expect((await POST(req, ctx)).status).toBe(409);
  });

  it('rejects an invalid action', async () => {
    const { req, ctx } = request('sg_1', { action: 'maybe' });
    expect((await POST(req, ctx)).status).toBe(400);
  });

  it('rejects: marks rejected without tagging', async () => {
    const { req, ctx } = request('sg_1', { action: 'reject' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(db.resolveNpcSuggestion).toHaveBeenCalledWith('sg_1', 'rejected', 'user_1');
    expect(db.tagClusterWithNewName).not.toHaveBeenCalled();
  });

  it('409s when a reject loses the resolve race', async () => {
    (db.resolveNpcSuggestion as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const { req, ctx } = request('sg_1', { action: 'reject' });
    expect((await POST(req, ctx)).status).toBe(409);
  });

  it('accepts with the suggested name when none provided', async () => {
    const { req, ctx } = request('sg_1', { action: 'accept' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(db.tagClusterWithNewName).toHaveBeenCalledWith({
      clusterId: 'cl_1',
      name: 'Innkeeper',
      memberId: 'mem_1',
      campaignId: 'camp_1',
    });
    expect(db.resolveNpcSuggestion).toHaveBeenCalledWith('sg_1', 'accepted', 'user_1');
  });

  it('accepts with an edited name', async () => {
    const { req, ctx } = request('sg_1', { action: 'accept', name: 'Greta the Innkeeper' });
    await POST(req, ctx);
    expect(db.tagClusterWithNewName).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Greta the Innkeeper' }),
    );
  });
});
