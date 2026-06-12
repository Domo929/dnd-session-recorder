import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { maybeEnqueueDiarization } from '@/services/diarization';
import { logger } from '@/lib/logger';
import { withHttpMetrics } from '@/lib/metrics';

/**
 * Fire-and-forget trigger for a downstream pipeline step. The child request can
 * run for up to an hour (full transcription/summary) while the frontend polls
 * progress, so we deliberately do NOT await it in the request path. We do,
 * however, attach handlers so that:
 *  - a network/abort failure is logged (but ignored when it's the expected
 *    long-poll timeout), and
 *  - a non-OK HTTP response (e.g. the child rejected the request outright and
 *    therefore never marked the session itself) transitions the session to
 *    `error` instead of leaving it stuck in `transcribing`/`summarizing`.
 */
function triggerPipelineStep(
  url: string,
  cookieHeader: string | null,
  sessionId: string,
  step: 'transcription' | 'summary',
): void {
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader && { Cookie: cookieHeader }),
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(60 * 60 * 1000), // 1 hour timeout
  })
    .then(async (res) => {
      if (res.ok) return;

      // A gateway/idle-timeout (502/503/504) means the proxy gave up waiting, not
      // that the work failed — the child handler is still running (full
      // transcription can far exceed the front-end's request timeout) and will
      // finish or mark its own error. Treating it as a failure here flashes a
      // spurious "request failed with status 504" before the run completes, so
      // we leave the in-progress state untouched for these statuses.
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        logger.warn('Pipeline step hit a gateway timeout; child still running', {
          sessionId,
          step,
          status: res.status,
        });
        return;
      }

      let detail = '';
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        // ignore body read errors
      }
      logger.error('Pipeline step returned a non-OK response', undefined, {
        sessionId,
        step,
        status: res.status,
        detail,
      });

      // Only fail the session if it's still sitting in the in-progress state we
      // set before firing this step. A child route may deliberately move the
      // session elsewhere on a non-OK response (e.g. transcription's file
      // reconciliation reverts to `draft` and returns 404); don't clobber that.
      const inProgressStatus = step === 'transcription' ? 'transcribing' : 'summarizing';
      try {
        const current = await db.getSessionById(sessionId);
        if (current?.status !== inProgressStatus) return;
        await db.updateSession(sessionId, {
          status: 'error',
          errorStep: step,
          errorMessage: `${step} request failed with status ${res.status}`,
        });
      } catch (updateErr) {
        logger.error('Failed to mark session errored after non-OK step', updateErr as Error, {
          sessionId,
          step,
        });
      }
    })
    .catch((err) => {
      // Ignore the expected long-poll timeout - the step runs in the background.
      if (err.name !== 'TimeoutError' && err.code !== 'UND_ERR_HEADERS_TIMEOUT') {
        logger.error(`Failed to trigger ${step}`, err, { sessionId });
      }
    });
}

/**
 * POST /api/sessions/[id]/process
 *
 * Orchestrates the full processing pipeline for a session:
 * 1. Ensures upload is linked to session
 * 2. Triggers transcription (if not already done)
 * 3. Triggers summary generation (if transcription exists)
 *
 * This endpoint is idempotent and resumable - it checks the current state
 * and only performs necessary steps.
 */
async function postHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;

  try {
    // Only the campaign owner may run the processing pipeline.
    const access = await requireSessionAccess(sessionId, 'owner');
    if (!access.ok) return access.response;

    const session = await db.getSessionById(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    logger.info('Starting processing pipeline', {
      sessionId,
      status: session.status
    });

    if (session.status === 'completed') {
      return NextResponse.json({
        message: 'Session already completed',
        status: 'completed',
        session
      });
    }

    if (['transcribing', 'summarizing'].includes(session.status)) {
      const { isTimedOut } = await db.checkProcessingTimeout(sessionId, 30);

      if (!isTimedOut) {
        return NextResponse.json({
          message: 'Session is currently being processed',
          status: session.status,
          session
        });
      }

      logger.warn('Session processing timed out, allowing restart', {
        sessionId,
        status: session.status
      });
    }

    if (!session.uploadId) {
      return NextResponse.json({
        error: 'Session has no audio file linked. Please upload an audio file first.',
        status: 'draft',
        needsUpload: true
      }, { status: 400 });
    }

    const upload = await db.getUploadById(session.uploadId);
    if (!upload) {
      return NextResponse.json({
        error: 'Audio file not found. Please upload an audio file.',
        status: 'draft',
        needsUpload: true
      }, { status: 400 });
    }

    const transcriptions = await db.getTranscriptions(sessionId);
    const hasTranscription = transcriptions && transcriptions.length > 0;

    if (!hasTranscription) {
      logger.info('Triggering transcription', { sessionId });

      await db.updateSession(sessionId, { status: 'transcribing' });

      const cookieHeader = request.headers.get('cookie');
      const baseUrl = process.env.NEXTAUTH_URL || request.nextUrl.origin;
      triggerPipelineStep(
        `${baseUrl}/api/transcription/${sessionId}`,
        cookieHeader,
        sessionId,
        'transcription',
      );

      return NextResponse.json({
        message: 'Transcription started',
        status: 'transcribing',
        step: 'transcription',
        session: await db.getSessionById(sessionId)
      });
    }

    // Speaker labels: enqueue diarization once transcription exists. Best-effort
    // so a failure here never blocks summary generation. The job stays queued
    // until the (deferred) dispatcher picks it up.
    try {
      await maybeEnqueueDiarization(session);
    } catch (err) {
      logger.error('Failed to enqueue diarization', err as Error, { sessionId });
    }

    // Step 2: Check summary status
    const summary = await db.getSummary(sessionId);
    const hasSummary = !!summary;

    if (!hasSummary) {
      logger.info('Triggering summary generation', { sessionId });

      // Update status to summarizing
      await db.updateSession(sessionId, { status: 'summarizing' });

      // Trigger summary generation asynchronously
      // Use NEXTAUTH_URL to avoid Fly.io's 0.0.0.0:3000 issue with request.nextUrl.origin
      const cookieHeader = request.headers.get('cookie');
      const baseUrl = process.env.NEXTAUTH_URL || request.nextUrl.origin;
      triggerPipelineStep(
        `${baseUrl}/api/summary/${sessionId}`,
        cookieHeader,
        sessionId,
        'summary',
      );

      return NextResponse.json({
        message: 'Summary generation started',
        status: 'summarizing',
        step: 'summary',
        session: await db.getSessionById(sessionId)
      });
    }

    // If we got here, everything is complete
    await db.updateSession(sessionId, { status: 'completed' });

    return NextResponse.json({
      message: 'Session processing complete',
      status: 'completed',
      session: await db.getSessionById(sessionId)
    });

  } catch (error) {
    logger.error('Processing pipeline error', error as Error, { sessionId });

    // Update session to error state
    try {
      await db.updateSession(sessionId, {
        status: 'error',
        errorStep: 'processing',
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    } catch (updateError) {
      logger.error('Failed to update session status', updateError as Error, { sessionId });
    }

    return NextResponse.json(
      { error: 'Failed to process session', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export const POST = withHttpMetrics('/api/sessions/[id]/process', postHandler);
