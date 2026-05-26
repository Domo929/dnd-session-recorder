import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hashInviteToken } from '@/lib/inviteTokens';

async function lookupLink(token: string) {
  const tokenHash = hashInviteToken(token);
  const link = await prisma.inviteLink.findUnique({
    where: { tokenHash },
    include: {
      campaign: {
        select: {
          id: true,
          name: true,
          creator: { select: { name: true, email: true } },
        },
      },
    },
  });
  if (!link) return null;
  if (link.revokedAt !== null) return null;
  if (link.expiresAt !== null && link.expiresAt <= new Date()) return null;
  return link;
}

// GET — preview the invitation. Returns 404 for invalid/expired/revoked
// tokens to avoid information leakage.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const link = await lookupLink(token);
  if (!link) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const existing = await prisma.member.findUnique({
    where: {
      campaignId_userId: {
        campaignId: link.campaignId,
        userId: session.user.id,
      },
    },
    select: { role: true },
  });

  return NextResponse.json({
    campaign: {
      id: link.campaign.id,
      name: link.campaign.name,
    },
    inviter: {
      name: link.campaign.creator.name,
    },
    alreadyMember: Boolean(existing),
    role: existing?.role ?? null,
  });
}

// POST — accept the invitation. Idempotent: if you're already a member,
// succeeds with `alreadyMember: true`.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const link = await lookupLink(token);
  if (!link) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const existing = await prisma.member.findUnique({
    where: {
      campaignId_userId: {
        campaignId: link.campaignId,
        userId: session.user.id,
      },
    },
  });

  if (existing) {
    return NextResponse.json({
      campaignId: link.campaignId,
      alreadyMember: true,
    });
  }

  await prisma.member.create({
    data: {
      campaignId: link.campaignId,
      userId: session.user.id,
      role: 'player',
      invitedBy: link.createdBy,
    },
  });

  return NextResponse.json({
    campaignId: link.campaignId,
    alreadyMember: false,
  });
}
