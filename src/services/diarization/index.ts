import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { db } from '@/services/database';
import { getStorageService } from '@/services/storage';
import { buildClusterSnippetPath } from '@/services/storage/voicePaths';
import { extractAudioClip } from '@/services/audioProcessing';
import { logger } from '@/lib/logger';

/** Max length of an unknown-speaker review snippet. */
export const SNIPPET_DURATION_SEC = 10;
/** Unknown-cluster snippets are retained 30 days unless promoted via lazy-tag. */
export const SNIPPET_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface EnqueueableSession {
  id: string;
  campaignId: string;
  transcriptionMode: string;
  diarizationStatus: string;
}

/**
 * Queue a diarization run when a freshly-transcribed session is in
 * speaker-labeled mode and its campaign has at least one enrolled voice to match
 * against. No-op (and safe to call repeatedly) otherwise. Returns whether a job
 * was created.
 */
export async function maybeEnqueueDiarization(session: EnqueueableSession): Promise<boolean> {
  if (session.transcriptionMode !== 'speaker_labeled') return false;
  // Only enqueue from the initial "none" state; queued/running/completed are skipped.
  if (session.diarizationStatus !== 'none') return false;

  const voiceCount = await db.countVoiceSamplesByCampaign(session.campaignId);
  if (voiceCount < 1) return false;

  await db.createDiarizationJob(session.id);
  logger.info('Diarization job enqueued', { sessionId: session.id, voiceCount });
  return true;
}

/**
 * Best-effort: cut a short representative clip for an unknown cluster from the
 * already-materialized session audio and upload it for later DM review/tagging.
 * Returns the snippet blob path, or null if generation/upload failed.
 */
export async function generateClusterSnippet(
  sourceAudioPath: string,
  sessionId: string,
  clusterIdx: number,
  representativeStartMs: number | undefined,
): Promise<string | null> {
  const tmpPath = path.join(os.tmpdir(), `cluster-snippet-${randomUUID()}.opus`);
  try {
    const startSec = Math.max(0, (representativeStartMs ?? 0) / 1000);
    await extractAudioClip(sourceAudioPath, tmpPath, startSec, SNIPPET_DURATION_SEC);

    const blobPath = buildClusterSnippetPath(sessionId, clusterIdx);
    await getStorageService().uploadFile(blobPath, tmpPath);
    return blobPath;
  } catch (err) {
    logger.error('Failed to generate cluster snippet', err as Error, { sessionId, clusterIdx });
    return null;
  } finally {
    await fs.promises.unlink(tmpPath).catch(() => {});
  }
}
