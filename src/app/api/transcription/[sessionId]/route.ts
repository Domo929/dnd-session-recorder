import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-utils';
import { db } from '@/services/database';
import { fileCleanup } from '@/services/fileCleanup';
import { splitAudioBySize, cleanupChunkFiles } from '@/services/audioProcessing';
import { transcribeWithBackoff, createTranscriptionPacer, transcriptionMinIntervalMs, isAiMocked, maxTranscriptionChunkSizeMB } from '@/lib/ai';
import { getStorageService } from '@/services/storage';
import { withMaterializedAudio } from '@/services/storage/materialize';
import { isTestAccount } from '@/lib/whitelist';
import fs from 'fs';
import { logger } from '@/lib/logger';

// Helper to update session status
async function updateSessionStatus(sessionId: string, status: string, errorStep?: string, errorMessage?: string): Promise<void> {
  try {
    await db.updateSession(sessionId, {
      status,
      errorStep: errorStep || null,
      errorMessage: errorMessage || null,
    });
  } catch (error) {
    logger.error('Failed to update session status', error as Error, { sessionId });
    throw error;
  }
}

// Helper to execute with timeout
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  return Promise.race([promise, timeout]);
}

// POST /api/transcription/[sessionId] - Transcribe audio
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  try {
    // No need to read request body - all info comes from session
    await request.json().catch(() => ({})); // Read body to prevent stream errors

    // Check authentication and get user info
    const { error: authError, user } = await requireAuth();
    if (authError) return authError;

    // COST PROTECTION: Block test accounts from making real AI API calls.
    // Skipped when AI is mocked — no spend, so the pipeline can be tested.
    if (isTestAccount(user.email!) && !isAiMocked()) {
      logger.warn('Blocked test account from transcription', {
        sessionId,
        userEmail: user.email
      });

      return NextResponse.json(
        {
          error: 'Test accounts cannot use AI transcription services. Please use a real email address to access this feature.',
          isTestAccount: true
        },
        { status: 403 }
      );
    }

    // Check if session exists and has an upload linked
    const session = await db.getSessionById(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // IDEMPOTENCY: Check if transcription already exists
    const existingTranscriptions = await db.getTranscriptions(sessionId);
    if (existingTranscriptions && existingTranscriptions.length > 0) {
      logger.info('Transcription already exists, skipping', { sessionId });

      // Update status to transcribed if not already
      if (session.status !== 'transcribed' && session.status !== 'completed') {
        await updateSessionStatus(sessionId, 'transcribed');
      }

      return NextResponse.json({
        message: 'Transcription already exists',
        transcriptionLength: existingTranscriptions[0].text.length,
        skipped: true
      });
    }

    // Get the file path from the linked upload
    if (!session.upload) {
      return NextResponse.json(
        { error: 'No audio file found for this session. Please upload an audio file first.' },
        { status: 400 }
      );
    }

    const upload = session.upload;
    const fullPath = upload.path;

    const audioExists =
      upload.storage === 'blob'
        ? (await getStorageService().head(upload.path)).exists
        : fs.existsSync(fullPath);

    if (!audioExists) {
      logger.warn('Audio file not found, performing reconciliation', {
        sessionId,
        path: fullPath
      });
      
      // File reconciliation: Remove database references to missing files
      try {
        if (session.upload) {
          logger.info('Removing upload record for missing file', {
            sessionId,
            uploadId: session.upload.id
          });
          await db.deleteUpload(session.upload.id);
        }

        // Clear the session's upload link and revert to draft status
        await db.updateSession(sessionId, {
          uploadId: null,
          status: 'draft'
        });

        logger.info('Cleaned up database records for missing file', { sessionId });
      } catch (cleanupError) {
        logger.error('File reconciliation cleanup failed', cleanupError as Error, { sessionId });
      }
      
      return NextResponse.json(
        { 
          error: `Audio file not found at path: ${fullPath}. Database records have been cleaned up. Please re-upload the file.`,
          fileReconciled: true
        },
        { status: 404 }
      );
    }

    logger.info('Starting transcription', { sessionId });

    // Load the campaign vocabulary ("NPC / term dictionary") once so every
    // chunk is transcribed with the same spelling bias.
    const campaign = await db.getCampaignById(session.campaignId);
    const transcriptionContext = {
      vocabulary: campaign?.transcriptionVocabulary ?? null,
    };

    // Start processing timer
    await db.startProcessing(sessionId);
    await updateSessionStatus(sessionId, 'transcribing');

    // Update progress: Starting chunking
    await db.updateTranscriptionProgress(sessionId, {
      currentStep: 'chunking',
      transcriptionProgress: 5,
    });

    // Split audio into provider-sized chunks (under each provider's request limit).
    // For blob-backed uploads the audio is downloaded to a temp file first and
    // removed afterward; local uploads use their on-disk path directly.
    const { fullText, chunkPaths } = await withMaterializedAudio(upload, async (localPath) => {
      const chunks = await splitAudioBySize(localPath, { maxChunkSizeMB: maxTranscriptionChunkSizeMB() });
      const chunkPaths = chunks.map(c => c.path);
      logger.info('Audio split into chunks', {
        sessionId,
        chunkCount: chunkPaths.length
      });

      // Resumable transcription: chunks are split by size, which is
      // deterministic for the same audio + chunk-size. transcriptionChunkCount
      // records the chunk count of the run that produced any persisted
      // TranscriptionChunk rows — a chunking signature. If a fresh split yields
      // the same count we resume (reuse persisted chunks); otherwise we discard
      // stale partial work and start fresh.
      const persistedCount = await db.getTranscriptionChunkCount(sessionId);
      let resumedChunks: Map<number, string>;
      if (persistedCount === chunkPaths.length) {
        resumedChunks = await db.getTranscriptionChunks(sessionId);
        if (resumedChunks.size > 0) {
          logger.info('Resuming transcription from persisted chunks', {
            sessionId,
            resumed: resumedChunks.size,
            totalChunks: chunkPaths.length,
          });
        }
      } else {
        await db.clearTranscriptionChunks(sessionId);
        await db.setTranscriptionChunkCount(sessionId, chunkPaths.length);
        resumedChunks = new Map();
      }

      // Update progress: Chunking complete, starting transcription
      await db.updateTranscriptionProgress(sessionId, {
        currentStep: 'transcribing',
        totalChunks: chunkPaths.length,
        chunksCompleted: resumedChunks.size,
        transcriptionProgress: 10,
      });

      const chunkTexts: string[] = new Array(chunkPaths.length);

      // Pace requests to stay under the provider's per-minute quota.
      const pace = createTranscriptionPacer(transcriptionMinIntervalMs());

      // Set timeout for each chunk: 30 minutes per chunk
      const CHUNK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

      for (let i = 0; i < chunkPaths.length; i++) {
        const chunkPath = chunkPaths[i];

        // Resume: already-transcribed chunk — skip the provider call entirely.
        const existing = resumedChunks.get(i);
        if (existing !== undefined) {
          chunkTexts[i] = existing;
          logger.debug('Skipping already-transcribed chunk', {
            sessionId,
            chunkNumber: i + 1,
            totalChunks: chunkPaths.length,
          });
          const progressPercentage = Math.floor(10 + ((i + 1) / chunkPaths.length) * 80);
          await db.updateTranscriptionProgress(sessionId, {
            chunksCompleted: i + 1,
            transcriptionProgress: progressPercentage,
          });
          continue;
        }

        logger.debug('Transcribing chunk', {
          sessionId,
          chunkNumber: i + 1,
          totalChunks: chunkPaths.length,
          path: chunkPath
        });

        try {
          // Read the file buffer for AI SDK
          const fileBuffer = fs.readFileSync(chunkPath);

          // Pace before each provider call to respect the RPM limit.
          await pace();

          const transcription = await withTimeout(
            transcribeWithBackoff(fileBuffer, { context: transcriptionContext }),
            CHUNK_TIMEOUT_MS,
            `Transcription timeout: Chunk ${i + 1}/${chunkPaths.length} took longer than 30 minutes`
          );

          if (!transcription.text) {
            throw new Error(`No transcription text received for chunk ${i + 1}`);
          }

          // Persist immediately so a later failure / retry resumes from here.
          await db.upsertTranscriptionChunk(sessionId, i, transcription.text);
          chunkTexts[i] = transcription.text;
          logger.info('Chunk transcribed successfully', {
            sessionId,
            chunkNumber: i + 1,
            totalChunks: chunkPaths.length
          });

          // Update progress after each chunk
          const progressPercentage = Math.floor(10 + ((i + 1) / chunkPaths.length) * 80); // 10-90% for transcription
          await db.updateTranscriptionProgress(sessionId, {
            chunksCompleted: i + 1,
            transcriptionProgress: progressPercentage,
          });
        } catch (chunkError) {
          logger.error('Chunk transcription failed', chunkError as Error, {
            sessionId,
            chunkNumber: i + 1,
            totalChunks: chunkPaths.length
          });

          // Clean up the temp chunk files we created. Persisted
          // TranscriptionChunk rows are intentionally left in place so the
          // retry resumes instead of re-transcribing completed chunks.
          cleanupChunkFiles(chunkPaths, localPath);

          throw new Error(
            `Failed to transcribe chunk ${i + 1}/${chunkPaths.length}: ${chunkError instanceof Error ? chunkError.message : String(chunkError)}`
          );
        }
      }

      // Update progress: Starting stitching
      await db.updateTranscriptionProgress(sessionId, {
        currentStep: 'stitching',
        transcriptionProgress: 90,
      });

      // Clean up chunk files (the materialized original is removed by withMaterializedAudio)
      cleanupChunkFiles(chunkPaths, localPath);
      logger.info('All chunks transcribed and cleaned up', { sessionId });

      // Combine all text chunks (in index order) into a single transcription
      return { fullText: chunkTexts.join(' '), chunkPaths };
    });

    // Save transcription to database
    await db.saveTranscription(sessionId, fullText);
    logger.info('Transcription saved', { sessionId, textLength: fullText.length });

    // Final transcript persisted — drop the per-chunk resume rows + signature.
    await db.clearTranscriptionChunks(sessionId);
    await db.setTranscriptionChunkCount(sessionId, null);
    
    // Update progress: Complete
    await db.updateTranscriptionProgress(sessionId, {
      currentStep: 'completed',
      transcriptionProgress: 100,
    });

    // Update session status to transcribed
    await updateSessionStatus(sessionId, 'transcribed');
    
    // Update upload status to transcribed if session has an upload
    if (session.uploadId) {
      await db.updateUploadStatus(session.uploadId, 'transcribed', chunkPaths);
    }

    // Clean up files after transcription is complete
    try {
      await fileCleanup.cleanupSessionFiles(sessionId);
    } catch (cleanupError) {
      logger.warn('File cleanup failed', {
        sessionId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      });
      // Don't fail the transcription if cleanup fails
    }

    logger.info('Transcription completed', { sessionId });

    return NextResponse.json({
      message: 'Transcription completed successfully',
      transcriptionLength: fullText.length
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('Timeout');

    logger.error('Transcription error', error as Error, {
      sessionId,
      isTimeout
    });

    await db.setSessionError(
      sessionId,
      isTimeout ? 'transcription_timeout' : 'transcription',
      errorMessage
    );

    return NextResponse.json(
      {
        error: 'Failed to transcribe audio',
        details: errorMessage,
        isTimeout,
        canRetry: true,
      },
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

  try {
    // Check authentication
    const { error } = await requireAuth();
    if (error) return error;

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

// DELETE /api/transcription/[sessionId] - Cancel transcription
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  try {
    // Check authentication
    const { error } = await requireAuth();
    if (error) return error;

    // Check if session exists
    const session = await db.getSessionById(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Check if processing has been running for more than 30 minutes
    const { isTimedOut, minutesElapsed } = await db.checkProcessingTimeout(sessionId, 30);

    // Cancel the transcription by resetting the session state
    await db.cancelTranscription(sessionId);

    logger.info('Transcription cancelled', {
      sessionId,
      minutesElapsed,
      wasTimedOut: isTimedOut
    });

    return NextResponse.json({
      message: 'Transcription cancelled successfully',
      wasTimedOut: isTimedOut,
      minutesElapsed,
    });
  } catch (error) {
    logger.error('Failed to cancel transcription', error as Error);

    return NextResponse.json(
      { error: 'Failed to cancel transcription' },
      { status: 500 }
    );
  }
}