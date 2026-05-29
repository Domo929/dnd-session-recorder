import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/services/database';
import { requireSessionAccess } from '@/lib/permissions';
import { logger } from '@/lib/logger';

// GET /api/sessions/[id]/transcriptions - Get transcriptions for a session
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;

  try {
    // Any member of the session's campaign may read its transcriptions.
    const access = await requireSessionAccess(sessionId, 'any');
    if (!access.ok) return access.response;

    // Get transcriptions
    const transcriptions = await db.getTranscriptions(sessionId);

    return NextResponse.json(transcriptions);
  } catch (error) {
    logger.error('Failed to fetch transcriptions', error as Error);

    return NextResponse.json(
      { error: 'Failed to fetch transcriptions' },
      { status: 500 }
    );
  }
}
