import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/database', () => ({ db: {} }));
vi.mock('@/lib/permissions', () => ({ requireCampaignAccess: vi.fn() }));

import { db } from '@/services/database';
import { requireCampaignAccess } from '@/lib/permissions';
import { GET } from '../route';

function getReq(id: string) {
  const req = new Request(
    `http://localhost/api/campaigns/${id}/speaker-registry`,
  ) as unknown as Parameters<typeof GET>[0];
  return { req, ctx: { params: Promise.resolve({ id }) } };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(db as unknown as Record<string, unknown>, {
    getCampaignSpeakerRegistry: vi.fn(async () => ['Bruce', 'Alice']),
  });
  vi.mocked(requireCampaignAccess).mockResolvedValue({
    ok: true,
    userId: 'u1',
    role: 'player',
  } as never);
});

describe('GET /api/campaigns/[id]/speaker-registry', () => {
  it('returns the registry names for a member', async () => {
    const { req, ctx } = getReq('camp_1');
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ names: ['Bruce', 'Alice'] });
  });

  it('propagates the access denial', async () => {
    vi.mocked(requireCampaignAccess).mockResolvedValueOnce({
      ok: false,
      response: new Response('no', { status: 404 }),
    } as never);
    const { req, ctx } = getReq('camp_1');
    expect((await GET(req, ctx)).status).toBe(404);
    expect(db.getCampaignSpeakerRegistry).not.toHaveBeenCalled();
  });
});
