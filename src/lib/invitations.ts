import { prisma } from '@/lib/prisma';

/**
 * Sweep pending Invitation rows for `email` and convert each into a
 * Member row for `userId`. Idempotent — safe to call on every signin.
 *
 * Returns the number of pending invitations consumed (0 on a cold path).
 */
export async function attachPendingInvitations(
  userId: string,
  email: string | null | undefined,
): Promise<number> {
  if (!email) return 0;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return 0;

  const pending = await prisma.invitation.findMany({
    where: { email: normalized, acceptedAt: null },
  });
  if (pending.length === 0) return 0;

  await prisma.$transaction([
    ...pending.map((inv) =>
      prisma.member.upsert({
        where: {
          campaignId_userId: { campaignId: inv.campaignId, userId },
        },
        create: {
          campaignId: inv.campaignId,
          userId,
          role: 'player',
          invitedBy: inv.invitedBy,
        },
        update: {},
      }),
    ),
    prisma.invitation.updateMany({
      where: { id: { in: pending.map((i) => i.id) } },
      data: { acceptedAt: new Date() },
    }),
  ]);

  console.log(
    `[invitations] attached ${pending.length} pending invitation(s) for ${normalized}`,
  );
  return pending.length;
}
