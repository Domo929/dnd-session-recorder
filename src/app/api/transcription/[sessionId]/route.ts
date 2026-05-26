import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/services/database';
import { requireCampaignAccess } from '@/lib/permissions';
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

  // Load the session first so we can derive its campaign for the access
  // check, then require owner access (transcription is a write operation
  // — players never trigger it). 404 (not 403) on no-access to avoid
  // leaking session existence; this matches the rest of the API surface.
  const session = await db.getSessionById(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const access = await requireCampaignAccess(session.campaignId, 'owner');
  if (!access.ok) return access.response;

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

  // Players (any member) can read transcripts; only owners can write
  // them (handled in POST above).
  const session = await db.getSessionById(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const access = await requireCampaignAccess(session.campaignId, 'any');
  if (!access.ok) return access.response;

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
