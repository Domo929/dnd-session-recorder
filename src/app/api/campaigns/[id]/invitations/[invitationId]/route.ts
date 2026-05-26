import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCampaignAccess } from '@/lib/permissions';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; invitationId: string }> },
) {
  const { id, invitationId } = await params;
  const access = await requireCampaignAccess(id, 'owner');
  if (!access.ok) return access.response;

  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
  });
  if (!invitation || invitation.campaignId !== id) {
    return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
  }

  await prisma.invitation.delete({ where: { id: invitationId } });
  return new NextResponse(null, { status: 204 });
}
