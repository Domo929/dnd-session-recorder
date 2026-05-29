import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireCampaignAccess } from '@/lib/permissions';
import { generateInviteToken, hashInviteToken } from '@/lib/inviteTokens';

const createSchema = z.object({
  expiresInDays: z.union([z.literal(7), z.literal(30), z.null()]).optional(),
});

function buildInviteUrl(request: NextRequest, rawToken: string): string {
  // Prefer NEXTAUTH_URL (the configured public app URL — same value
  // NextAuth uses for OAuth callbacks). This avoids returning internal
  // hostnames like the Docker container id when the app is behind a
  // proxy or reverse-routed, which would otherwise leak via the
  // request URL / Host header. Fall back to the request origin only
  // if NEXTAUTH_URL isn't set (e.g. some unconfigured dev setup).
  const configured = process.env.NEXTAUTH_URL?.replace(/\/$/, '');
  if (configured) {
    return `${configured}/campaigns/invite/${rawToken}`;
  }
  const origin = request.headers.get('origin') ?? new URL(request.url).origin;
  return `${origin}/campaigns/invite/${rawToken}`;
}

// GET — return current active link metadata (no token).
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await requireCampaignAccess(id, 'owner');
  if (!access.ok) return access.response;

  const link = await prisma.inviteLink.findFirst({
    where: { campaignId: id, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!link) return NextResponse.json({ link: null });

  const expired = link.expiresAt !== null && link.expiresAt <= new Date();
  return NextResponse.json({
    link: {
      id: link.id,
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
      expired,
    },
  });
}

// POST — revoke previous active link(s) and issue a new one. Returns the
// raw URL once. Owner must copy it; we can't reconstruct it after this.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await requireCampaignAccess(id, 'owner');
  if (!access.ok) return access.response;

  let parsed: z.infer<typeof createSchema>;
  try {
    parsed = createSchema.parse(await request.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: e.issues },
        { status: 400 },
      );
    }
    throw e;
  }

  const expiresAt =
    parsed.expiresInDays && parsed.expiresInDays > 0
      ? new Date(Date.now() + parsed.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

  const rawToken = generateInviteToken();
  const tokenHash = hashInviteToken(rawToken);

  const link = await prisma.$transaction(async (tx) => {
    await tx.inviteLink.updateMany({
      where: { campaignId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return tx.inviteLink.create({
      data: {
        campaignId: id,
        tokenHash,
        createdBy: access.userId,
        expiresAt,
      },
    });
  });

  return NextResponse.json(
    {
      link: {
        id: link.id,
        url: buildInviteUrl(request, rawToken),
        createdAt: link.createdAt,
        expiresAt: link.expiresAt,
      },
    },
    { status: 201 },
  );
}

// DELETE — revoke any active link(s).
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await requireCampaignAccess(id, 'owner');
  if (!access.ok) return access.response;

  await prisma.inviteLink.updateMany({
    where: { campaignId: id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return new NextResponse(null, { status: 204 });
}
