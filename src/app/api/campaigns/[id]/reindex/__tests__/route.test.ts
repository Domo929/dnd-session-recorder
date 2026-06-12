import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-utils', () => ({ requireAuthForSensitiveAction: vi.fn() }));
vi.mock('@/lib/permissions', () => ({ getCampaignAccess: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    gamingSession: {
      findMany: vi.fn(),
    },
  },
}));
vi.mock('@/lib/ai', () => ({ isAiMocked: vi.fn() }));
vi.mock('@/lib/whitelist', () => ({ isTestAccount: vi.fn() }));
vi.mock('@/services/campaignIndex', () => ({ reindexSession: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));

import { requireAuthForSensitiveAction } from '@/lib/auth-utils';
import { getCampaignAccess } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';
import { isAiMocked } from '@/lib/ai';
import { isTestAccount } from '@/lib/whitelist';
import { reindexSession } from '@/services/campaignIndex';
import { logger } from '@/lib/logger';
import { POST } from '../route';

function post(campaignId: string) {
  return {
    request: new Request(`http://localhost/api/campaigns/${campaignId}/reindex`, {
      method: 'POST',
    }) as Parameters<typeof POST>[0],
    ctx: { params: Promise.resolve({ id: campaignId }) },
  };
}

const authedUser = { id: 'user_1', email: 'dm@real.com', name: 'DM' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthForSensitiveAction).mockResolvedValue({
    error: null,
    user: authedUser,
  } as never);
  vi.mocked(isTestAccount).mockReturnValue(false);
  vi.mocked(isAiMocked).mockReturnValue(false);
  vi.mocked(getCampaignAccess).mockResolvedValue('owner');
  vi.mocked(prisma.gamingSession.findMany).mockResolvedValue([]);
  vi.mocked(reindexSession).mockResolvedValue(undefined);
});

describe('POST /api/campaigns/[id]/reindex', () => {
  it('returns the sensitive auth error when not signed in', async () => {
    vi.mocked(requireAuthForSensitiveAction).mockResolvedValue({
      error: NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
      user: null,
    } as never);

    const { request, ctx } = post('camp_1');
    const res = await POST(request, ctx);

    expect(res.status).toBe(401);
    expect(getCampaignAccess).not.toHaveBeenCalled();
  });

  it('403s test accounts when AI is not mocked', async () => {
    vi.mocked(requireAuthForSensitiveAction).mockResolvedValue({
      error: null,
      user: { ...authedUser, email: 'dm@test.com' },
    } as never);
    vi.mocked(isTestAccount).mockReturnValue(true);
    vi.mocked(isAiMocked).mockReturnValue(false);

    const { request, ctx } = post('camp_1');
    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Test accounts cannot use AI indexing.' });
    expect(getCampaignAccess).not.toHaveBeenCalled();
  });

  it('404s non-owners without leaking campaign existence', async () => {
    vi.mocked(getCampaignAccess).mockResolvedValue('player');

    const { request, ctx } = post('camp_1');
    const res = await POST(request, ctx);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(prisma.gamingSession.findMany).not.toHaveBeenCalled();
  });

  it('reindexes every completed campaign session and logs per-session failures', async () => {
    vi.mocked(prisma.gamingSession.findMany).mockResolvedValue([
      { id: 'sess_1' },
      { id: 'sess_2' },
    ] as never);
    const failure = new Error('index failed');
    vi.mocked(reindexSession)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure);

    const { request, ctx } = post('camp_1');
    const res = await POST(request, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      message: 'Reindex complete',
      sessions: 2,
      indexed: 1,
    });
    expect(prisma.gamingSession.findMany).toHaveBeenCalledWith({
      where: { campaignId: 'camp_1', status: 'completed' },
      select: { id: true },
    });
    expect(reindexSession).toHaveBeenNthCalledWith(1, 'sess_1');
    expect(reindexSession).toHaveBeenNthCalledWith(2, 'sess_2');
    expect(logger.error).toHaveBeenCalledWith('Backfill reindex failed', failure, { sessionId: 'sess_2' });
  });
});
