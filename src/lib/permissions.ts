import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export type CampaignRole = 'owner' | 'player';
export type AccessLevel = 'any' | 'owner';

/**
 * Returns the user's role on the campaign, or null if they have no
 * membership. Owner-or-player are the only roles today; future roles
 * (co-DM, etc) would be added here.
 */
export async function getCampaignAccess(
  userId: string,
  campaignId: string,
): Promise<CampaignRole | null> {
  const member = await prisma.member.findUnique({
    where: { campaignId_userId: { campaignId, userId } },
    select: { role: true },
  });
  if (!member) return null;
  if (member.role === 'owner' || member.role === 'player') {
    return member.role;
  }
  return null;
}

export type RequireAccessResult =
  | { ok: true; userId: string; role: CampaignRole }
  | { ok: false; response: NextResponse };

export type RequireSignedInResult =
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse };

/**
 * Cheap auth-only check for routes that need to look up DB state (e.g.
 * resolve a session id to its campaign) BEFORE they can call
 * requireCampaignAccess. Returning 401 here keeps us from leaking the
 * existence of arbitrary session ids to unauthenticated callers.
 */
export async function requireSignedIn(): Promise<RequireSignedInResult> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  return { ok: true, userId: session.user.id };
}

/**
 * One-stop access check for API routes. Always:
 *   - 401 if not signed in
 *   - 404 if no membership (do not leak existence)
 *   - 404 if level='owner' and role='player' (same — do not leak)
 *
 * Usage:
 *   const access = await requireCampaignAccess(campaignId, 'owner');
 *   if (!access.ok) return access.response;
 *   // access.userId, access.role are available here
 */
export async function requireCampaignAccess(
  campaignId: string,
  level: AccessLevel,
): Promise<RequireAccessResult> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  const role = await getCampaignAccess(session.user.id, campaignId);
  if (!role) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Not found' }, { status: 404 }),
    };
  }
  if (level === 'owner' && role !== 'owner') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Not found' }, { status: 404 }),
    };
  }
  return { ok: true, userId: session.user.id, role };
}

export type RequireSessionAccessResult =
  | { ok: true; userId: string; role: CampaignRole; campaignId: string }
  | { ok: false; response: NextResponse };

/**
 * Access check for routes keyed by a gaming-session id. Resolves the session
 * to its campaign and applies the same membership rules as
 * `requireCampaignAccess`:
 *   - 401 if not signed in
 *   - 404 if the session doesn't exist (do not leak existence)
 *   - 404 if the user has no membership on the session's campaign
 *   - 404 if level='owner' and the user is only a player
 */
export async function requireSessionAccess(
  sessionId: string,
  level: AccessLevel,
): Promise<RequireSessionAccessResult> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const gs = await prisma.gamingSession.findUnique({
    where: { id: sessionId },
    select: { campaignId: true },
  });
  const notFound = NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!gs) {
    return { ok: false, response: notFound };
  }

  const role = await getCampaignAccess(session.user.id, gs.campaignId);
  if (!role) {
    return { ok: false, response: notFound };
  }
  if (level === 'owner' && role !== 'owner') {
    return { ok: false, response: notFound };
  }
  return { ok: true, userId: session.user.id, role, campaignId: gs.campaignId };
}
