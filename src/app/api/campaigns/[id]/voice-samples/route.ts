import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { requireCampaignAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { getStorageService } from '@/services/storage';
import { voiceSamplePathOwnedBy } from '@/services/storage/voicePaths';
import { getVoiceEmbeddingService } from '@/services/voiceEmbedding';
import { serializeEmbedding } from '@/lib/voiceFingerprint';
import { getAudioDuration } from '@/services/audioProcessing';
import {
  normalizeVoiceLabel,
  validateVoiceDurationMs,
  embeddingModelFor,
} from '@/lib/voiceEnrollment';
import { logger } from '@/lib/logger';

interface FinalizeRequest {
  blobPath?: string;
  label?: string;
}

/**
 * GET /api/campaigns/[id]/voice-samples
 *
 * Lists the caller's own voice library within the campaign (binary embeddings
 * are never returned).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await requireCampaignAccess(id, 'any');
  if (!access.ok) return access.response;

  const memberId = await db.getMemberId(id, access.userId);
  if (!memberId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const voiceSamples = await db.listVoiceSamplesByMember(memberId);
  return NextResponse.json({ voiceSamples });
}

/**
 * POST /api/campaigns/[id]/voice-samples
 *
 * Finalizes an enrollment clip previously PUT to Blob: validates the clip,
 * embeds it on the app's CPU, and stores the resulting `VoiceSample`. The clip's
 * duration is measured server-side rather than trusting the client.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await requireCampaignAccess(id, 'any');
  if (!access.ok) return access.response;

  const body = (await request.json().catch(() => ({}))) as FinalizeRequest;
  const { blobPath } = body;

  const labelResult = normalizeVoiceLabel(body.label ?? '');
  if (!labelResult.ok) {
    return NextResponse.json({ error: labelResult.error }, { status: 400 });
  }
  if (!blobPath || typeof blobPath !== 'string') {
    return NextResponse.json({ error: 'Missing required field: blobPath' }, { status: 400 });
  }
  // Defend the finalize step: only accept a path this user was issued a SAS for.
  if (!voiceSamplePathOwnedBy(blobPath, access.userId)) {
    return NextResponse.json({ error: 'Invalid blobPath' }, { status: 400 });
  }

  const memberId = await db.getMemberId(id, access.userId);
  if (!memberId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const storage = getStorageService();

  const head = await storage.head(blobPath);
  if (!head.exists) {
    return NextResponse.json(
      { error: 'Upload not found. Please record and upload the clip again.' },
      { status: 400 },
    );
  }

  let tempPath: string | null = null;
  try {
    tempPath = await storage.materializeToTempFile(blobPath);

    const durationSec = await getAudioDuration(tempPath).catch(() => NaN);
    const durationResult = validateVoiceDurationMs(Math.round(durationSec * 1000));
    if (!durationResult.ok) {
      await storage.delete(blobPath);
      return NextResponse.json({ error: durationResult.error }, { status: 400 });
    }

    const audio = await fs.promises.readFile(tempPath);
    const embedder = getVoiceEmbeddingService();
    const vector = await embedder.embedClip(audio);
    const embedding = serializeEmbedding(vector);

    const sample = await db.createVoiceSample({
      memberId,
      label: labelResult.label,
      audioPath: blobPath,
      embedding,
      embeddingModel: embeddingModelFor(embedder.backend),
      durationMs: durationResult.durationMs,
      source: 'enrolled',
    });

    return NextResponse.json(
      {
        voiceSample: {
          id: sample.id,
          label: sample.label,
          durationMs: sample.durationMs,
          source: sample.source,
          exemplarCount: sample.exemplarCount,
          createdAt: sample.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Duplicate (memberId, label): the row was never created, so drop the blob.
      await storage.delete(blobPath).catch(() => {});
      return NextResponse.json(
        { error: 'You already have a voice sample with that label.' },
        { status: 409 },
      );
    }
    logger.error('Failed to finalize voice sample', err as Error, { userId: access.userId });
    return NextResponse.json({ error: 'Failed to save voice sample' }, { status: 500 });
  } finally {
    if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
  }
}
