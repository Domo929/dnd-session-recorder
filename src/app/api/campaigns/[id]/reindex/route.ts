import { NextRequest, NextResponse } from 'next/server';
import { requireAuthForSensitiveAction } from '@/lib/auth-utils';
import { getCampaignAccess } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';
import { isAiMocked } from '@/lib/ai';
import { isTestAccount } from '@/lib/whitelist';
import { reindexSession } from '@/services/campaignIndex';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;

  const { error, user } = await requireAuthForSensitiveAction(request);
  if (error) return error;

  if (isTestAccount(user.email!) && !isAiMocked()) {
    return NextResponse.json({ error: 'Test accounts cannot use AI indexing.' }, { status: 403 });
  }

  const role = await getCampaignAccess(user.id, campaignId);
  if (role !== 'owner') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const sessions = await prisma.gamingSession.findMany({
    where: { campaignId, status: 'completed' },
    select: { id: true },
  });

  let indexed = 0;
  for (const s of sessions) {
    try {
      await reindexSession(s.id);
      indexed++;
    } catch (err) {
      logger.error('Backfill reindex failed', err as Error, { sessionId: s.id });
    }
  }

  return NextResponse.json({ message: 'Reindex complete', sessions: sessions.length, indexed });
}
