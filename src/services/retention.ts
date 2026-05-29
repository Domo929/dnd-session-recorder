import { db } from '@/services/database';
import { getStorageService } from '@/services/storage';
import { logger } from '@/lib/logger';

export interface PurgeResult {
  scanned: number;
  purged: number;
  failed: number;
}

/**
 * Delete session audio whose retention window has elapsed. Blob deletion and
 * the DB tombstone happen per-upload and best-effort: one failure is logged and
 * skipped without aborting the rest. Transcripts/clusters/summaries are kept.
 */
export async function purgeExpiredAudio(now: Date = new Date()): Promise<PurgeResult> {
  const uploads = await db.getExpiredAudioUploads(now);
  const storage = getStorageService();
  let purged = 0;
  let failed = 0;

  for (const upload of uploads) {
    try {
      await storage.delete(upload.path);
      await db.markAudioPurged(upload.id);
      purged++;
    } catch (err) {
      failed++;
      logger.error('Audio retention purge failed for upload', err as Error, { uploadId: upload.id });
    }
  }

  logger.info('Audio retention purge complete', { scanned: uploads.length, purged, failed });
  return { scanned: uploads.length, purged, failed };
}

/**
 * Delete unknown-cluster review snippets that were never tagged within their
 * retention window. The cluster row is kept (the DM still sees "Unknown #N",
 * just without a playable snippet). Best-effort per snippet.
 */
export async function purgeExpiredSnippets(now: Date = new Date()): Promise<PurgeResult> {
  const clusters = await db.getExpiredSnippetClusters(now);
  const storage = getStorageService();
  let purged = 0;
  let failed = 0;

  for (const cluster of clusters) {
    try {
      await storage.delete(cluster.snippetBlobPath);
      await db.clearClusterSnippet(cluster.id);
      purged++;
    } catch (err) {
      failed++;
      logger.error('Snippet retention purge failed for cluster', err as Error, { clusterId: cluster.id });
    }
  }

  logger.info('Snippet retention purge complete', { scanned: clusters.length, purged, failed });
  return { scanned: clusters.length, purged, failed };
}
