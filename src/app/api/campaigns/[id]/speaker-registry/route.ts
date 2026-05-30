import { NextRequest, NextResponse } from 'next/server';
import { requireCampaignAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * GET /api/campaigns/[id]/speaker-registry
 *
 * The virtual campaign speaker registry used to power relabel autocomplete and
 * keep names consistent: a deduplicated, casing-canonical union of enrolled
 * voice labels, member display names, accepted NPC suggestions, and names
 * already used in this campaign's relabels. Any member may read it.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;
  try {
    const access = await requireCampaignAccess(campaignId, 'any');
    if (!access.ok) return access.response;

    const names = await db.getCampaignSpeakerRegistry(campaignId);
    return NextResponse.json({ names });
  } catch (error) {
    logger.error('Failed to load speaker registry', error as Error, { campaignId });
    return NextResponse.json({ error: 'Failed to load speaker registry' }, { status: 500 });
  }
}
