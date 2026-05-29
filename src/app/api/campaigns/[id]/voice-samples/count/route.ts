import { NextRequest, NextResponse } from 'next/server';
import { requireCampaignAccess } from '@/lib/permissions';
import { db } from '@/services/database';

/**
 * GET /api/campaigns/[id]/voice-samples/count
 *
 * Lightweight campaign-wide enrollment summary used by the session-create form
 * to pre-fill and gate the transcription-mode toggle: the campaign's default
 * mode plus how many voices are enrolled across all members.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await requireCampaignAccess(id, 'any');
  if (!access.ok) return access.response;

  const campaign = await db.getCampaignById(id);
  if (!campaign) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const count = await db.countVoiceSamplesByCampaign(id);
  return NextResponse.json({
    count,
    defaultMode: campaign.defaultTranscriptionMode,
  });
}
