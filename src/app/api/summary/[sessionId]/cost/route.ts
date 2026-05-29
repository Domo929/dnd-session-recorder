import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { estimateSummaryCost, getConfiguredSummaryModel } from '@/lib/summaryCost';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * GET /api/summary/[sessionId]/cost
 *
 * Estimate the cost of (re-)summarizing this session with the currently
 * configured provider/model, so the re-summarize dialog can show it up front
 * (design Section 6). `estimate` is null for models without known pricing.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  try {
    const access = await requireSessionAccess(sessionId, 'owner');
    if (!access.ok) return access.response;

    const transcriptions = await db.getTranscriptions(sessionId);
    const transcriptChars = transcriptions.reduce((n, t) => n + t.text.length, 0);

    const { provider, modelId } = getConfiguredSummaryModel();
    const estimate = estimateSummaryCost(provider, modelId, transcriptChars);

    return NextResponse.json({ provider, modelId, transcriptChars, estimate });
  } catch (error) {
    logger.error('Failed to estimate summary cost', error as Error, { sessionId });
    return NextResponse.json({ error: 'Failed to estimate cost' }, { status: 500 });
  }
}
