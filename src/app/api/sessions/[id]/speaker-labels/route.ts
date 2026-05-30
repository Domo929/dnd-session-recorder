import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSessionAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { canonicalizeName, normalizeName } from '@/lib/speakerNameMatch';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sessions/[id]/speaker-labels
 *
 * The basic-mode relabeling state for a session: per-speaker-key defaults and
 * per-turn overrides. Any campaign member may read it so everyone sees the
 * resolved names; only owners may write (PUT). Turns themselves are derived
 * client-side from the transcript the page already has.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;
  try {
    const access = await requireSessionAccess(sessionId, 'any');
    if (!access.ok) return access.response;

    const labels = await db.getSpeakerLabels(sessionId);
    return NextResponse.json({ ...labels, canEdit: access.role === 'owner' });
  } catch (error) {
    logger.error('Failed to load speaker labels', error as Error, { sessionId });
    return NextResponse.json({ error: 'Failed to load speaker labels' }, { status: 500 });
  }
}

const putSchema = z
  .object({
    defaults: z
      .array(z.object({ speakerKey: z.string().min(1).max(64), name: z.string().max(120) }))
      .optional(),
    turns: z
      .array(z.object({ turnIndex: z.number().int().min(0), name: z.string().max(120) }))
      .optional(),
  })
  .refine((b) => (b.defaults?.length ?? 0) + (b.turns?.length ?? 0) > 0, {
    message: 'Provide at least one default or turn to update',
  });

/**
 * PUT /api/sessions/[id]/speaker-labels
 *
 * Owner-only. Upserts defaults/overrides; a blank name clears that entry.
 * Non-empty names are canonicalized against the campaign registry first, so a
 * differently-cased or near-typo name snaps to the existing canonical spelling
 * (keeps `bruce`/`Bruce` from diverging). Flags the session for re-summarize.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;
  try {
    const access = await requireSessionAccess(sessionId, 'owner');
    if (!access.ok) return access.response;

    const parsed = putSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, { status: 400 });
    }

    const registry = await db.getCampaignSpeakerRegistry(access.campaignId);
    const canon = (name: string) => (name.trim() ? canonicalizeName(name, registry) : '');

    await db.upsertSpeakerLabels(
      sessionId,
      access.campaignId,
      {
        defaults: parsed.data.defaults?.map((d) => ({ speakerKey: d.speakerKey, name: canon(d.name) })),
        turns: parsed.data.turns?.map((t) => ({ turnIndex: t.turnIndex, name: canon(t.name) })),
      },
      normalizeName,
    );

    const labels = await db.getSpeakerLabels(sessionId);
    return NextResponse.json({ ...labels, canEdit: true });
  } catch (error) {
    logger.error('Failed to update speaker labels', error as Error, { sessionId });
    return NextResponse.json({ error: 'Failed to update speaker labels' }, { status: 500 });
  }
}
