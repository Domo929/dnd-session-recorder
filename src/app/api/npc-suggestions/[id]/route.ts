import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requireCampaignAccess } from '@/lib/permissions';
import { db, ClusterAlreadyTaggedError } from '@/services/database';
import { logger } from '@/lib/logger';

const resolveSchema = z.object({
  action: z.enum(['accept', 'reject']),
  name: z.string().trim().min(1).max(80).optional(),
});

/**
 * POST /api/npc-suggestions/[id]
 *
 * Owner-only. Accept an inferred NPC name (optionally edited) — which tags the
 * cluster via the §3 cascade — or reject the suggestion. Accept uses the edited
 * `name` when provided, otherwise the model's `suggestedName`.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const suggestion = await db.getNpcSuggestionById(id);
    if (!suggestion) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const access = await requireCampaignAccess(suggestion.session.campaignId, 'owner');
    if (!access.ok) return access.response;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = resolveSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }

    if (suggestion.status !== 'pending') {
      return NextResponse.json({ error: 'Suggestion already resolved' }, { status: 409 });
    }

    if (parsed.data.action === 'reject') {
      const ok = await db.resolveNpcSuggestion(id, 'rejected', access.userId);
      if (!ok) return NextResponse.json({ error: 'Suggestion already resolved' }, { status: 409 });
      return NextResponse.json({ ok: true, status: 'rejected' });
    }

    // accept → tag the cluster with the (possibly edited) name + run cascade.
    const memberId = await db.getMemberId(suggestion.session.campaignId, access.userId);
    if (!memberId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const name = parsed.data.name ?? suggestion.suggestedName;
    const result = await db.tagClusterWithNewName({
      clusterId: suggestion.clusterId,
      name,
      memberId,
      campaignId: suggestion.session.campaignId,
    });
    await db.resolveNpcSuggestion(id, 'accepted', access.userId);
    return NextResponse.json({ ok: true, status: 'accepted', ...result });
  } catch (error) {
    if (error instanceof ClusterAlreadyTaggedError) {
      return NextResponse.json({ error: 'Speaker already tagged' }, { status: 409 });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json({ error: 'A voice with that name already exists' }, { status: 409 });
    }
    logger.error('Failed to resolve NPC suggestion', error as Error, { id });
    return NextResponse.json({ error: 'Failed to resolve suggestion' }, { status: 500 });
  }
}
