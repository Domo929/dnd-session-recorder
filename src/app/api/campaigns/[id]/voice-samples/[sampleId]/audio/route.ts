import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import { requireCampaignAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { getStorageService } from '@/services/storage';
import { logger } from '@/lib/logger';

/**
 * GET /api/campaigns/[id]/voice-samples/[sampleId]/audio
 *
 * Streams a voice clip the caller owns so the Voice Library can play it back.
 * The bytes are proxied through the app (clips are tiny, ~15s) rather than
 * handing out a read SAS, keeping the blob namespace fully private.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sampleId: string }> },
) {
  const { id, sampleId } = await params;
  const access = await requireCampaignAccess(id, 'any');
  if (!access.ok) return access.response;

  const sample = await db.getVoiceSampleWithOwner(sampleId);
  if (
    !sample ||
    sample.member.userId !== access.userId ||
    sample.member.campaignId !== id
  ) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let tempPath: string | null = null;
  try {
    tempPath = await getStorageService().materializeToTempFile(sample.audioPath);
    const audio = await fs.promises.readFile(tempPath);
    return new NextResponse(new Uint8Array(audio), {
      status: 200,
      headers: {
        'Content-Type': 'audio/webm',
        'Content-Length': String(audio.length),
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err) {
    logger.error('Failed to stream voice clip', err as Error, { sampleId });
    return NextResponse.json({ error: 'Failed to load audio' }, { status: 500 });
  } finally {
    if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
  }
}
