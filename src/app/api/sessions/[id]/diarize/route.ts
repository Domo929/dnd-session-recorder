import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { logger } from '@/lib/logger';

/**
 * POST /api/sessions/[id]/diarize
 *
 * Owner-only on-demand bridge from a basic transcript to a speaker-labeled one.
 * Flips the session to speaker-labeled mode and queues a diarization job for the
 * background dispatcher to launch. Guards:
 *   - session audio must still be present (the retention cron purges old blobs);
 *   - blob-backed (the dispatcher can only stream blob storage);
 *   - no diarization already queued or running (avoid double work).
 * Idempotent enough to retry after a failed/none run.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;

  try {
    const access = await requireSessionAccess(sessionId, 'owner');
    if (!access.ok) return access.response;

    const session = await db.getSessionById(sessionId);
    if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (session.diarizationStatus === 'queued' || session.diarizationStatus === 'running') {
      return NextResponse.json(
        { error: 'Diarization is already in progress for this session' },
        { status: 409 },
      );
    }

    const upload = session.upload;
    if (!upload || upload.status === 'cleaned') {
      return NextResponse.json(
        { error: 'Session audio is no longer available. Re-upload the recording first.' },
        { status: 409 },
      );
    }
    if (upload.storage !== 'blob') {
      return NextResponse.json(
        { error: 'Diarization requires a blob-backed upload.' },
        { status: 409 },
      );
    }

    const job = await db.createOnDemandDiarizationJob(sessionId);
    logger.info('On-demand diarization enqueued', { sessionId, jobId: job.id });
    return NextResponse.json({ ok: true, jobId: job.id });
  } catch (error) {
    logger.error('Failed to enqueue on-demand diarization', error as Error, { sessionId });
    return NextResponse.json({ error: 'Failed to start diarization' }, { status: 500 });
  }
}
