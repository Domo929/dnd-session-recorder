import { NextRequest, NextResponse } from 'next/server';
import { requireCampaignAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { getStorageService } from '@/services/storage';
import { logger } from '@/lib/logger';

/**
 * DELETE /api/campaigns/[id]/voice-samples/[sampleId]
 *
 * Removes a voice sample the caller owns: deletes the Blob clip and the row.
 * Past `SessionSpeakerCluster`s referencing it have their `voiceSampleId`
 * set to NULL by the schema's onDelete: SetNull (reverting to "Unknown").
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sampleId: string }> },
) {
  const { id, sampleId } = await params;
  const access = await requireCampaignAccess(id, 'any');
  if (!access.ok) return access.response;

  const sample = await db.getVoiceSampleWithOwner(sampleId);
  // Don't leak existence across users/campaigns: a mismatch is a 404.
  if (
    !sample ||
    sample.member.userId !== access.userId ||
    sample.member.campaignId !== id
  ) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    await getStorageService().delete(sample.audioPath);
  } catch (err) {
    // The row is the source of truth; a stranded blob is swept by the SL-6 cron.
    logger.error('Failed to delete voice clip blob', err as Error, { sampleId });
  }

  await db.deleteVoiceSample(sampleId);
  return NextResponse.json({ ok: true });
}
