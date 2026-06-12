import { NextRequest, NextResponse } from 'next/server';
import { requireCampaignAccess } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';
import { embedTexts, buildChatMessages, streamCampaignChat, isAiMocked } from '@/lib/ai';
import { isTestAccount } from '@/lib/whitelist';
import { formatCitation } from '@/lib/citation';

interface RetrievedRow {
  sessionTitle: string;
  sourceType: string;
  startTime: number | null;
  speakerLabels: string[];
  text: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;

  const access = await requireCampaignAccess(campaignId, 'any');
  if (!access.ok) return access.response;

  // Cost guard: chat spends money unless AI is mocked.
  const u = await prisma.user.findUnique({ where: { id: access.userId }, select: { email: true } });
  if (u?.email && isTestAccount(u.email) && !isAiMocked()) {
    return NextResponse.json({ error: 'Test accounts cannot use AI chat.' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const messages: { role: 'user' | 'assistant'; content: string }[] = Array.isArray(body?.messages)
    ? body.messages
    : [];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser || !lastUser.content?.trim()) {
    return NextResponse.json({ error: 'No question provided' }, { status: 400 });
  }

  const [questionEmbedding] = await embedTexts([lastUser.content]);
  const vec = `[${questionEmbedding.join(',')}]`;

  const rows = await prisma.$queryRaw<RetrievedRow[]>`
    SELECT gs.title          AS "sessionTitle",
           cc.source_type    AS "sourceType",
           cc.start_time     AS "startTime",
           cc.speaker_labels AS "speakerLabels",
           cc.text           AS "text"
    FROM campaign_chunks cc
    JOIN gaming_sessions gs ON gs.id = cc.session_id
    WHERE cc.campaign_id = ${campaignId}
      AND cc.embedding IS NOT NULL
    ORDER BY cc.embedding <=> ${vec}::vector
    LIMIT 8
  `;

  const context = rows
    .map((r) => `${formatCitation(r)}\n${r.text}`)
    .join('\n\n---\n\n');

  const result = streamCampaignChat(buildChatMessages(context, messages));
  return result.toTextStreamResponse();
}
