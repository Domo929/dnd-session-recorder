import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-utils';
import { db } from '@/services/database';
import { createUploadFromBlob, UploadCompletionError } from '@/services/storage/createUploadFromBlob';
import { logger, getUserContext } from '@/lib/logger';

interface CreateWithUploadRequest {
  title?: string;
  campaign_id?: string;
  session_date?: string;
  blobPath?: string;
  originalName?: string;
  mimetype?: string;
  size?: number;
}

/**
 * POST /api/sessions/create-with-upload
 *
 * Atomic session creation: the browser has already PUT the audio to Blob, so
 * this accepts a `blobPath` (JSON, not multipart) and:
 *  1. Validates campaign ownership.
 *  2. Mints the Upload row from the landed blob.
 *  3. Creates the session linked to the upload.
 *  4. Fires the processing pipeline.
 */
export async function POST(request: NextRequest) {
  let createdSessionId: string | null = null;

  try {
    const { error, user } = await requireAuth();
    if (error) return error;

    logger.apiRequest('POST', '/api/sessions/create-with-upload', getUserContext({ user }));

    const body = (await request.json().catch(() => ({}))) as CreateWithUploadRequest;
    const { title, campaign_id: campaignId, session_date: sessionDate } = body;
    const { blobPath, originalName, mimetype, size } = body;

    if (!title || !campaignId || !sessionDate) {
      return NextResponse.json(
        { error: 'Missing required fields: title, campaign_id, session_date' },
        { status: 400 },
      );
    }

    // Verify campaign exists and belongs to user
    const campaign = await db.getCampaignById(campaignId);
    if (!campaign || campaign.userId !== user.id) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    }

    let uploadId: string | undefined;
    let duration: number | undefined;

    // Mint the Upload row from the already-uploaded blob (if audio was provided)
    if (blobPath) {
      if (!originalName || !mimetype || typeof size !== 'number') {
        return NextResponse.json(
          { error: 'blobPath requires originalName, mimetype, and size' },
          { status: 400 },
        );
      }

      const upload = await createUploadFromBlob(user.id, { blobPath, originalName, mimetype, size });
      uploadId = upload.id;
      duration = upload.duration ?? undefined;
      logger.info('Upload record created for session creation', { uploadId, userId: user.id });
    }

    // Create gaming session (with or without upload)
    const session = await db.createSession({
      userId: user.id,
      campaignId,
      title,
      sessionDate: new Date(sessionDate),
      uploadId,
      duration,
      status: uploadId ? 'uploaded' : 'draft',
    });

    createdSessionId = session.id;
    logger.info('Session created', {
      sessionId: session.id,
      campaignId,
      uploadId,
      status: session.status,
      userId: user.id,
    });

    // If audio was uploaded, trigger processing pipeline (fire and forget)
    if (uploadId) {
      const cookieHeader = request.headers.get('cookie');
      fetch(`${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/sessions/${session.id}/process`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cookieHeader && { Cookie: cookieHeader }),
        },
        signal: AbortSignal.timeout(60 * 60 * 1000), // 1 hour timeout
      }).catch((err) => {
        if (err.name !== 'TimeoutError' && err.code !== 'UND_ERR_HEADERS_TIMEOUT') {
          logger.error('Failed to trigger processing pipeline', err, {
            sessionId: session.id,
            userId: user.id,
          });
        }
      });

      logger.info('Processing pipeline triggered', { sessionId: session.id, userId: user.id });
    }

    return NextResponse.json(
      {
        message: 'Session created successfully',
        session: {
          id: session.id,
          title: session.title,
          campaignId: session.campaignId,
          sessionDate: session.sessionDate,
          uploadId: session.uploadId,
          duration: session.duration,
          status: session.status,
          createdAt: session.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof UploadCompletionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    logger.apiError('POST', '/api/sessions/create-with-upload', error as Error, {
      sessionId: createdSessionId ?? undefined,
    });

    // If we have a session ID, return it so the user can navigate to it
    if (createdSessionId) {
      return NextResponse.json(
        {
          error: 'Session created but encountered an error during setup',
          sessionId: createdSessionId,
          message: 'You can continue from the session page',
        },
        { status: 207 },
      );
    }

    return NextResponse.json(
      { error: 'Failed to create session', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
