import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { logger } from '@/lib/logger';

/**
 * POST /api/sessions/[id]/rematch
 *
 * Owner-only. Re-score this session's still-unknown speaker clusters against the
 * campaign's current voices (seed + learned exemplars) and auto-link confident
 * matches — the manual "label a couple, then apply the learning to the rest"
 * affordance. Affected sessions are flagged for re-summarization.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;

  try {
    const access = await requireSessionAccess(sessionId, 'owner');
    if (!access.ok) return access.response;

    const { linked } = await db.rematchSessionClusters(sessionId, access.campaignId);
    logger.info('Session rematch complete', { sessionId, linked: linked.length });
    return NextResponse.json({ ok: true, linked });
  } catch (error) {
    logger.error('Failed to rematch session clusters', error as Error, { sessionId });
    return NextResponse.json({ error: 'Failed to re-run matching' }, { status: 500 });
  }
}
