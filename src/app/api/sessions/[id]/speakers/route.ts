import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { groupTurns } from '@/lib/speakerTranscript';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sessions/[id]/speakers
 *
 * Speaker-aware transcript payload for the session detail view: the diarized
 * clusters (with labels, match info, NPC suggestions, snippet availability) and
 * the transcript grouped into consecutive same-speaker turns. Any campaign
 * member may read it; owners additionally get the voice-tagging options.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;

  try {
    const access = await requireSessionAccess(sessionId, 'any');
    if (!access.ok) return access.response;

    const session = await db.getSessionById(sessionId);
    if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const clusters = await db.getSessionClusters(sessionId);
    const transcriptions = await db.getTranscriptions(sessionId);

    const turns = groupTurns(
      transcriptions.map((t) => ({
        speakerClusterId: t.speakerClusterId,
        startTime: t.startTime,
        text: t.text,
      })),
    );

    const voiceOptions =
      access.role === 'owner' ? await db.getCampaignVoiceOptions(access.campaignId) : [];

    return NextResponse.json({
      transcriptionMode: session.transcriptionMode,
      diarizationStatus: session.diarizationStatus,
      needsResummarize: session.needsResummarize,
      clusters,
      turns,
      voiceOptions,
      canTag: access.role === 'owner',
    });
  } catch (error) {
    logger.error('Failed to load speaker transcript', error as Error, { sessionId });
    return NextResponse.json({ error: 'Failed to load speaker transcript' }, { status: 500 });
  }
}
