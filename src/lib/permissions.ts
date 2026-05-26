import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
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
