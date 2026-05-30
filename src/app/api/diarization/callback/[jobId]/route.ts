import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/services/database';
import { getStorageService } from '@/services/storage';
import {
  verifyCallbackSignature,
  parseDiarizationPayload,
  type DiarizationCluster,
} from '@/lib/diarizationCallback';
import {
  deserializeEmbedding,
  matchCluster,
  shouldLearn,
  getFingerprintConfig,
} from '@/lib/voiceFingerprint';
import { embeddingModelFor } from '@/lib/voiceEnrollment';
import { generateClusterSnippet, SNIPPET_RETENTION_MS } from '@/services/diarization';
import { logger } from '@/lib/logger';
import { metrics, recordVoiceMatch, withHttpMetrics } from '@/lib/metrics';

export const dynamic = 'force-dynamic';

const SIGNATURE_HEADER = 'x-signature';

interface ResolvedCluster {
  cluster: DiarizationCluster;
  dbClusterId: string;
}

/**
 * POST /api/diarization/callback/[jobId]
 *
 * The GPU diarization container posts speaker-attributed segments + per-cluster
 * mean embeddings here. We authenticate via the per-job HMAC, then:
 *   1. match each cluster to a campaign voice (self-refining fingerprints),
 *   2. fold high-confidence matches back into the matched voice (learning),
 *   3. generate review snippets for unknown clusters,
 *   4. replace the session's transcriptions with speaker-attributed rows,
 *   5. mark the session for speaker-aware re-summarization.
 */
async function postHandler(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;

  const rawBody = await request.text();
  const job = await db.getDiarizationJobById(jobId);
  if (!job) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!verifyCallbackSignature(job.hmacSecret, rawBody, request.headers.get(SIGNATURE_HEADER))) {
    logger.warn('Diarization callback signature rejected', { jobId });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Replay guard: a finished job must not be reprocessed. Transcription
  // replacement is destructive, so a stale replay could clobber good data.
  if (job.status === 'completed' || job.status === 'failed') {
    logger.warn('Diarization callback for an already-finished job', { jobId, status: job.status });
    return NextResponse.json({ error: 'Job already processed' }, { status: 409 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = parseDiarizationPayload(json);
  if (!parsed.ok) {
    logger.warn('Diarization callback payload rejected', { jobId, error: parsed.error });
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const payload = parsed.payload;

  const sessionId = job.sessionId;
  const campaignId = job.session.campaignId;

  try {
    const fingerprints = await db.getCampaignFingerprints(campaignId);
    const config = getFingerprintConfig();
    const exemplarModel = embeddingModelFor('onnx');

    // Materialize the session audio once if any cluster might need a snippet.
    let sourceAudioPath: string | null = null;
    const upload = job.session.uploadId ? await db.getUploadById(job.session.uploadId) : null;
    const cleanupAudio = async () => {
      if (sourceAudioPath) {
        await fs.promises.unlink(sourceAudioPath).catch(() => {});
        sourceAudioPath = null;
      }
    };
    const ensureSourceAudio = async (): Promise<string | null> => {
      if (sourceAudioPath) return sourceAudioPath;
      if (!upload) return null;
      try {
        sourceAudioPath = await getStorageService().materializeToTempFile(upload.path);
        return sourceAudioPath;
      } catch (err) {
        logger.error('Failed to materialize session audio for snippets', err as Error, { sessionId });
        return null;
      }
    };

    const resolved: ResolvedCluster[] = [];
    let unknownCount = 0;

    try {
      // Deterministic ordering so the "Unknown #N" counter is stable.
      const clusters = [...payload.clusters].sort((a, b) => a.clusterIdx - b.clusterIdx);

      for (const cluster of clusters) {
        const centroid = deserializeEmbedding(cluster.embeddingCentroid);
        const match = matchCluster(centroid, fingerprints, config);
        recordVoiceMatch(match.matchConfidence, match.matchedScore);

        let displayLabel: string;
        let voiceSampleId: string | null;
        let matchConfidence: string;
        let matchedScore: number | null;
        let snippetBlobPath: string | null = null;
        let snippetExpiresAt: Date | null = null;

        if (match.kind === 'matched') {
          displayLabel = match.displayLabel;
          voiceSampleId = match.voiceSampleId;
          matchConfidence = match.matchConfidence;
          matchedScore = match.matchedScore;
        } else {
          unknownCount += 1;
          displayLabel = `DM (Unknown #${unknownCount})`;
          voiceSampleId = null;
          matchConfidence = 'none';
          matchedScore = match.matchedScore;

          const audioPath = await ensureSourceAudio();
          if (audioPath) {
            snippetBlobPath = await generateClusterSnippet(
              audioPath,
              sessionId,
              cluster.clusterIdx,
              cluster.representativeStartMs,
            );
            if (snippetBlobPath) snippetExpiresAt = new Date(Date.now() + SNIPPET_RETENTION_MS);
          }
        }

        const dbCluster = await db.upsertSpeakerCluster({
          sessionId,
          campaignId,
          clusterIdx: cluster.clusterIdx,
          embeddingCentroid: cluster.embeddingCentroid,
          segmentCount: cluster.segmentCount,
          totalDurationMs: cluster.totalDurationMs,
          displayLabel,
          voiceSampleId,
          matchConfidence,
          matchedScore,
          snippetBlobPath,
          snippetExpiresAt,
        });
        resolved.push({ cluster, dbClusterId: dbCluster.id });

        // Learning: only high-confidence auto-matches refine a fingerprint.
        if (match.kind === 'matched' && shouldLearn(match, false, config)) {
          await db.addLearnedExemplar({
            voiceSampleId: match.voiceSampleId,
            embedding: cluster.embeddingCentroid,
            embeddingModel: exemplarModel,
            source: 'auto_matched',
            sourceSessionId: sessionId,
            similarityAtCapture: match.matchedScore,
            durationMs: cluster.totalDurationMs,
            maxExemplars: config.maxExemplars,
          });
          metrics.voiceLearned.inc();
        }
      }
    } finally {
      await cleanupAudio();
    }

    // Replace the session's transcriptions with speaker-attributed segments.
    const clusterIdxToDbId = new Map(resolved.map((r) => [r.cluster.clusterIdx, r.dbClusterId]));
    const rows = payload.segments
      .map((seg) => {
        const speakerClusterId = clusterIdxToDbId.get(seg.clusterIdx);
        if (!speakerClusterId) return null;
        return {
          startTime: seg.startMs / 1000,
          endTime: seg.endMs / 1000,
          text: seg.text,
          confidence: seg.confidence ?? null,
          speakerClusterId,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    await db.completeDiarizationJob({ sessionId, jobId, uploadId: job.session.uploadId, rows });

    logger.info('Diarization callback processed', {
      jobId,
      sessionId,
      clusters: resolved.length,
      unknownClusters: unknownCount,
      segments: rows.length,
    });

    metrics.diarizationCallbacks.inc({ status: 'success' });
    return NextResponse.json({ ok: true, clusters: resolved.length, segments: rows.length });
  } catch (err) {
    logger.error('Failed to process diarization callback', err as Error, { jobId, sessionId });
    metrics.diarizationCallbacks.inc({ status: 'error' });
    await db
      .updateDiarizationJob(jobId, {
        status: 'failed',
        finishedAt: new Date(),
        incrementAttempt: true,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      .catch(() => {});
    await db.setSessionDiarizationStatus(sessionId, 'failed').catch(() => {});
    return NextResponse.json({ error: 'Failed to process callback' }, { status: 500 });
  }
}

export const POST = withHttpMetrics('/api/diarization/callback/[jobId]', postHandler);
