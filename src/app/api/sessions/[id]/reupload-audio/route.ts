import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { createUploadFromBlob, UploadCompletionError } from '@/services/storage/createUploadFromBlob';
import { logger } from '@/lib/logger';

interface ReuploadRequest {
  blobPath?: string;
  originalName?: string;
  mimetype?: string;
  size?: number;
}

/**
 * POST /api/sessions/[id]/reupload-audio
 *
 * Owner-only. After the retention cron purges a diarized session's audio, the
 * DM can re-attach the recording so it can be (re-)diarized. The browser PUTs to
 * a fresh SAS URL (`/api/uploads/sas`) and posts the blob descriptor here; we
 * turn it into an `Upload` row and point the session at it. The user is trusted
 * to upload the same recording (no verification is possible).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;

  try {
    const access = await requireSessionAccess(sessionId, 'owner');
    if (!access.ok) return access.response;

    const session = await db.getSessionById(sessionId);
    if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = (await request.json().catch(() => ({}))) as ReuploadRequest;
    const { blobPath, originalName, mimetype, size } = body;
    if (!blobPath || !originalName || !mimetype || typeof size !== 'number') {
      return NextResponse.json(
        { error: 'Missing required fields: blobPath, originalName, mimetype, size' },
        { status: 400 },
      );
    }

    const upload = await createUploadFromBlob(access.userId, { blobPath, originalName, mimetype, size });
    await db.updateSession(sessionId, { uploadId: upload.id });

    logger.info('Session audio re-uploaded', { sessionId, uploadId: upload.id });
    return NextResponse.json({ ok: true, uploadId: upload.id });
  } catch (error) {
    if (error instanceof UploadCompletionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Failed to re-upload session audio', error as Error, { sessionId });
    return NextResponse.json({ error: 'Failed to re-upload audio' }, { status: 500 });
  }
}
