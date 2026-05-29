import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { logger } from '@/lib/logger';

// GET /api/sessions/[id]/progress - Get session progress
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionId = (await params).id;

    // Any member of the session's campaign may read its progress.
    const access = await requireSessionAccess(sessionId, 'any');
    if (!access.ok) return access.response;

    // Get session with progress information
    const session = await db.getSessionById(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Return progress information
    return NextResponse.json({
      status: session.status,
      duration: session.duration,
      transcriptionProgress: session.transcriptionProgress || 0,
      totalChunks: session.totalChunks || 0,
      chunksCompleted: session.chunksCompleted || 0,
      currentStep: session.currentStep || null,
      errorStep: session.errorStep || null,
      errorMessage: session.errorMessage || null,
    });
  } catch (error) {
    logger.error('Failed to fetch session progress', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch session progress' },
      { status: 500 }
    );
  }
}
