import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/permissions', () => ({ requireCampaignAccess: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

import { requireCampaignAccess } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';
import { GET } from '../route';

function get(campaignId: string, query = '') {
  return {
    request: new Request(`http://localhost/api/campaigns/${campaignId}/search${query}`) as Parameters<typeof GET>[0],
    ctx: { params: Promise.resolve({ id: campaignId }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireCampaignAccess).mockResolvedValue({
    ok: true,
    userId: 'user_1',
    role: 'player',
  });
  vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
});

describe('GET /api/campaigns/[id]/search', () => {
  it('returns the campaign access error before searching', async () => {
    vi.mocked(requireCampaignAccess).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Not found' }, { status: 404 }),
    });

    const { request, ctx } = get('camp_1', '?q=dragon');
    const res = await GET(request, ctx);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(requireCampaignAccess).toHaveBeenCalledWith('camp_1', 'any');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('short-circuits blank queries without searching', async () => {
    const { request, ctx } = get('camp_1', '?q=%20%20');
    const res = await GET(request, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    expect(requireCampaignAccess).toHaveBeenCalledWith('camp_1', 'any');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns matching campaign chunk rows', async () => {
    const rows = [
      {
        sessionId: 'sess_1',
        sessionTitle: 'Goblin Ambush',
        sourceType: 'transcript',
        startTime: 12,
        speakerLabels: ['DM'],
        snippet: '<mark>goblin</mark> leaps out',
      },
    ];
    vi.mocked(prisma.$queryRaw).mockResolvedValue(rows);

    const { request, ctx } = get('camp_1', '?q=goblin');
    const res = await GET(request, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: rows });
    expect(requireCampaignAccess).toHaveBeenCalledWith('camp_1', 'any');
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });
});
