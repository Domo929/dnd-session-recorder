import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/services/database';
import { fileCleanup } from '@/services/fileCleanup';
import { transcribeAudio } from '@/services/ai';
import fs from 'fs';
import path from 'path';

// Helper to update session status
async function updateSessionStatus(sessionId: string, status: string, errorStep?: string, errorMessage?: string): Promise<void> {
  try {
    await db.updateSession(sessionId, {
      status,
      errorStep: errorStep || null,
      errorMessage: errorMessage || null,
    });
  } catch (error) {
    console.error('Error updating session status:', error);
    throw error;
  }
}

// POST /api/transcription/[sessionId] - Transcribe audio
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  // Auth gate must run BEFORE we touch the DB or any AI service. We do not
  // accept any body params — the upload's absolute path on disk is the
  // single source of truth for which file to transcribe. (Previously the
  // route accepted `audioFilePath` from the request body, which both
  // double-dipped with `session.upload.path` and was a path-traversal risk
  // for anyone who could call this endpoint.)
  const userSession = await getServerSession(authOptions);
  if (!userSession?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Load the session and verify the caller owns its campaign. We return
  // 404 (not 403) on ownership failure to avoid leaking the existence of
  // sessions that belong to other users — same pattern as the rest of
  // the API surface (see /api/sessions/[id]/upload/route.ts).
  const session = await db.getSessionById(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const campaign = await db.getCampaignById(session.campaignId);
  if (!campaign || campaign.userId !== userSession.user.id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    let fullPath: string;
    if (session.upload) {
      fullPath = path.resolve(session.upload.path);
    } else if (session.audioFilePath) {
      fullPath = path.resolve(session.audioFilePath);
    } else {
      return NextResponse.json(
        { error: 'No audio file found for this session' },
        { status: 400 }
      );
    }

    if (!fs.existsSync(fullPath)) {
      return NextResponse.json(
        { error: `Audio file not found at path: ${fullPath}` },
        { status: 404 }
      );
    }

    console.log(`[Transcription] Starting transcription for session ${sessionId}`);
    await updateSessionStatus(sessionId, 'transcribing');

    // Dispatch to the configured transcription provider
    // (AI_TRANSCRIPTION_PROVIDER env var: openai | google | whisper-local)
    const fullText = await transcribeAudio(fullPath);

    // Save transcription to database
    await db.saveTranscription(sessionId, fullText);
    console.log(`[Transcription] Transcription saved.`);

    // Update session status to transcribed
    await updateSessionStatus(sessionId, 'transcribed');

    // Update upload status to transcribed if session has an upload
    if (session.uploadId) {
      await db.updateUploadStatus(session.uploadId, 'transcribed');
    }

    // Clean up files after transcription is complete
    try {
      await fileCleanup.cleanupSessionFiles(sessionId);
    } catch (cleanupError) {
      console.warn(`[Transcription] File cleanup failed for session ${sessionId}:`, cleanupError);
      // Don't fail the transcription if cleanup fails
    }

    console.log(`[Transcription] Transcription completed for session ${sessionId}`);

    return NextResponse.json({
      message: 'Transcription completed successfully',
      transcriptionLength: fullText.length
    });

  } catch (error) {
    console.error('[Transcription Error]:', error);
    await updateSessionStatus(
      sessionId,
      'error',
      'transcription',
      error instanceof Error ? error.message : String(error)
    );

    return NextResponse.json(
      { error: 'Failed to transcribe audio' },
      { status: 500 }
    );
  }
}

// GET /api/transcription/[sessionId] - Get transcriptions for a session
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  // Same auth + ownership pattern as POST. We never return transcript
  // text to anyone who doesn't own the campaign.
  const userSession = await getServerSession(authOptions);
  if (!userSession?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await db.getSessionById(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const campaign = await db.getCampaignById(session.campaignId);
  if (!campaign || campaign.userId !== userSession.user.id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    const transcriptions = await db.getTranscriptions(sessionId);

    return NextResponse.json(transcriptions);
  } catch (error) {
    console.error('Error fetching transcriptions:', error);

    return NextResponse.json(
      { error: 'Failed to fetch transcriptions' },
      { status: 500 }
    );
  }
}
