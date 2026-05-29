import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireCampaignAccess } from '@/lib/permissions';

const addByEmailSchema = z.object({
  email: z.string().email(),
});

// GET — list members. Players see name + role + joinedAt only.
// Owners additionally see email and pending invitations.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await requireCampaignAccess(id, 'any');
  if (!access.ok) return access.response;

  const members = await prisma.member.findMany({
    where: { campaignId: id },
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
  });

  const isOwner = access.role === 'owner';
  const payload = members.map((m) => ({
    userId: m.userId,
    name: m.user.name,
    email: isOwner ? m.user.email : null,
    role: m.role,
    joinedAt: m.joinedAt,
    isSelf: m.userId === access.userId,
  }));

  const pending = isOwner
    ? await prisma.invitation.findMany({
        where: { campaignId: id, acceptedAt: null },
        orderBy: { createdAt: 'asc' },
      })
    : [];

  return NextResponse.json({
    members: payload,
    pendingInvitations: pending.map((p) => ({
      id: p.id,
      email: p.email,
      createdAt: p.createdAt,
    })),
    viewerRole: access.role,
  });
}

// POST — owner adds a player by email. Three outcomes:
//   - added: user exists, new Member row created
//   - already_member: user exists and was already a Member
//   - pending: user does not exist, Invitation pre-staged
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await requireCampaignAccess(id, 'owner');
  if (!access.ok) return access.response;

  let parsed: { email: string };
  try {
    parsed = addByEmailSchema.parse(await request.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: e.issues },
        { status: 400 },
      );
    }
    throw e;
  }
  const normalized = parsed.email.trim().toLowerCase();

  const user = await prisma.user.findUnique({ where: { email: normalized } });

  if (user) {
    if (user.id === access.userId) {
      return NextResponse.json(
        { status: 'self', message: "You're the owner of this campaign." },
        { status: 400 },
      );
    }

    const existing = await prisma.member.findUnique({
      where: { campaignId_userId: { campaignId: id, userId: user.id } },
    });
    if (existing) {
      return NextResponse.json({
        status: 'already_member',
        member: { userId: user.id, name: user.name, email: user.email, role: existing.role },
      });
    }

    const member = await prisma.member.create({
      data: {
        campaignId: id,
        userId: user.id,
        role: 'player',
        invitedBy: access.userId,
      },
    });

    return NextResponse.json(
      {
        status: 'added',
        member: { userId: user.id, name: user.name, email: user.email, role: member.role },
      },
      { status: 201 },
    );
  }

  const invitation = await prisma.invitation.upsert({
    where: { campaignId_email: { campaignId: id, email: normalized } },
    create: { campaignId: id, email: normalized, invitedBy: access.userId },
    update: {},
  });

  return NextResponse.json(
    {
      status: 'pending',
      invitation: { id: invitation.id, email: normalized, createdAt: invitation.createdAt },
    },
    { status: 201 },
  );
}
