import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requireCampaignAccess } from '@/lib/permissions';
import { db, ClusterAlreadyTaggedError } from '@/services/database';
import { logger } from '@/lib/logger';

const tagSchema = z
  .object({
    voiceSampleId: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(80).optional(),
  })
  .refine((v) => !!v.voiceSampleId !== !!v.name, {
    message: 'Provide exactly one of voiceSampleId or name',
  });

/**
 * POST /api/clusters/[clusterId]/tag
 *
 * Owner-only. Tag an unidentified speaker cluster either by linking it to an
 * existing campaign voice, or by naming it (which promotes the cluster snippet
 * to a new voice and runs the campaign-wide lazy-tag cascade — design §3).
 * Affected sessions are flagged for re-summarization.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ clusterId: string }> },
) {
  const { clusterId } = await params;

  try {
    const cluster = await db.getClusterForTagging(clusterId);
    if (!cluster) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const access = await requireCampaignAccess(cluster.session.campaignId, 'owner');
    if (!access.ok) return access.response;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = tagSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, { status: 400 });
    }

    if (parsed.data.voiceSampleId) {
      await db.tagClusterWithExistingVoice(clusterId, parsed.data.voiceSampleId, cluster.sessionId);
      return NextResponse.json({ ok: true, affectedSessionIds: [cluster.sessionId] });
    }

    const memberId = await db.getMemberId(cluster.session.campaignId, access.userId);
    if (!memberId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const result = await db.tagClusterWithNewName({
      clusterId,
      name: parsed.data.name!,
      memberId,
      campaignId: cluster.session.campaignId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ClusterAlreadyTaggedError) {
      return NextResponse.json({ error: 'Speaker already tagged' }, { status: 409 });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json({ error: 'A voice with that name already exists' }, { status: 409 });
    }
    logger.error('Failed to tag cluster', error as Error, { clusterId });
    return NextResponse.json({ error: 'Failed to tag cluster' }, { status: 500 });
  }
}
