import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/permissions', () => ({ requireCampaignAccess: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));
vi.mock('@/lib/ai', () => ({
  embedTexts: vi.fn(),
  buildChatMessages: vi.fn(),
  streamCampaignChat: vi.fn(),
  isAiMocked: vi.fn(),
}));
vi.mock('@/lib/whitelist', () => ({ isTestAccount: vi.fn() }));
vi.mock('@/lib/citation', () => ({ formatCitation: vi.fn() }));

import { requireCampaignAccess } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';
import { embedTexts, buildChatMessages, streamCampaignChat, isAiMocked } from '@/lib/ai';
import { isTestAccount } from '@/lib/whitelist';
import { formatCitation } from '@/lib/citation';
import { POST } from '../route';

function post(campaignId: string, messages: { role: 'user' | 'assistant'; content: string }[]) {
  return {
    request: new Request(`http://localhost/api/campaigns/${campaignId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ messages }),
      headers: { 'content-type': 'application/json' },
    }) as Parameters<typeof POST>[0],
    ctx: { params: Promise.resolve({ id: campaignId }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireCampaignAccess).mockResolvedValue({ ok: true, userId: 'user_1', role: 'owner' });
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ email: 'dm@real.com' } as never);
  vi.mocked(isTestAccount).mockReturnValue(false);
  vi.mocked(isAiMocked).mockReturnValue(false);
  vi.mocked(embedTexts).mockResolvedValue([[0.1, 0.2, 0.3]]);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
  vi.mocked(buildChatMessages).mockReturnValue([{ role: 'user', content: 'built' }]);
  vi.mocked(streamCampaignChat).mockReturnValue({
    toTextStreamResponse: () => new Response('ok'),
  } as never);
  vi.mocked(formatCitation).mockReturnValue('[Session]');
});

describe('POST /api/campaigns/[id]/chat', () => {
  it('returns 400 when no user message is provided', async () => {
    const { request, ctx } = post('camp_1', [{ role: 'assistant', content: 'hello' }]);

    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No question provided' });
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('returns 400 when the latest user message is blank', async () => {
    const { request, ctx } = post('camp_1', [{ role: 'user', content: '   ' }]);

    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No question provided' });
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('returns 400 when messages is not an array', async () => {
    const request = new Request('http://localhost/api/campaigns/camp_1/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: { role: 'user', content: 'Question?' } }),
      headers: { 'content-type': 'application/json' },
    }) as Parameters<typeof POST>[0];

    const res = await POST(request, { params: Promise.resolve({ id: 'camp_1' }) });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No question provided' });
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('403s test accounts when AI is not mocked', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ email: 'dm@test.com' } as never);
    vi.mocked(isTestAccount).mockReturnValue(true);
    vi.mocked(isAiMocked).mockReturnValue(false);

    const { request, ctx } = post('camp_1', [{ role: 'user', content: 'What happened?' }]);
    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Test accounts cannot use AI chat.' });
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('embeds the latest user message and returns the streamed response', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      {
        sessionTitle: 'Session 1',
        sourceType: 'transcript',
        startTime: 12,
        speakerLabels: ['DM'],
        text: 'The party entered the dungeon.',
      },
    ]);

    const messages = [
      { role: 'user' as const, content: 'Earlier question' },
      { role: 'assistant' as const, content: 'Earlier answer' },
      { role: 'user' as const, content: 'What happened last?' },
    ];
    const { request, ctx } = post('camp_1', messages);

    const res = await POST(request, ctx);

    expect(await res.text()).toBe('ok');
    expect(embedTexts).toHaveBeenCalledWith(['What happened last?']);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const queryParts = vi.mocked(prisma.$queryRaw).mock.calls[0]?.[0] as TemplateStringsArray;
    expect(String.raw({ raw: queryParts })).toContain('AND cc.embedding IS NOT NULL');
    expect(formatCitation).toHaveBeenCalledWith({
      sessionTitle: 'Session 1',
      sourceType: 'transcript',
      startTime: 12,
      speakerLabels: ['DM'],
      text: 'The party entered the dungeon.',
    });
    expect(buildChatMessages).toHaveBeenCalledWith('[Session]\nThe party entered the dungeon.', messages);
    expect(streamCampaignChat).toHaveBeenCalledWith([{ role: 'user', content: 'built' }]);
  });

  it('returns the access error when the user lacks campaign access', async () => {
    vi.mocked(requireCampaignAccess).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Not found' }, { status: 404 }),
    });

    const { request, ctx } = post('camp_1', [{ role: 'user', content: 'Question?' }]);
    const res = await POST(request, ctx);

    expect(res.status).toBe(404);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
