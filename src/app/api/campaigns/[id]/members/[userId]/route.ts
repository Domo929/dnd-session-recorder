import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCampaignAccess } from '@/lib/permissions';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  const { id, userId } = await params;
  const access = await requireCampaignAccess(id, 'owner');
  if (!access.ok) return access.response;

  const target = await prisma.member.findUnique({
    where: { campaignId_userId: { campaignId: id, userId } },
  });
  if (!target) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 });
  }

  // Refuse to leave a campaign ownerless.
  if (target.role === 'owner') {
    const ownerCount = await prisma.member.count({
      where: { campaignId: id, role: 'owner' },
    });
    if (ownerCount <= 1) {
      return NextResponse.json(
        { error: 'Cannot remove the sole owner of a campaign.' },
        { status: 400 },
      );
    }
  }

  await prisma.member.delete({
    where: { campaignId_userId: { campaignId: id, userId } },
  });

  return new NextResponse(null, { status: 204 });
}
