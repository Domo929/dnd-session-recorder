import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { AlertCircle } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hashInviteToken } from '@/lib/inviteTokens';
import Button from '@/components/ui/Button';
import AcceptButton from './AcceptButton';

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

export default async function InviteRedemptionPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect('/auth/signin');
  }

  const link = await lookupLink(token);
  if (!link) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="bg-white rounded-xl border border-gray-200 p-8 max-w-md w-full text-center">
          <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">
            Invite no longer valid
          </h1>
          <p className="text-gray-600 mb-6">
            This invite link has expired or been revoked. Ask the campaign owner
            for a new one.
          </p>
          <Link href="/campaigns">
            <Button>Back to campaigns</Button>
          </Link>
        </div>
      </div>
    );
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

  if (existing) {
    redirect(`/campaigns/${link.campaignId}`);
  }

  const inviterName = link.campaign.creator.name ?? 'A campaign owner';

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="bg-white rounded-xl border border-gray-200 p-8 max-w-md w-full text-center space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">
            You&apos;ve been invited
          </h1>
          <p className="text-gray-600">
            {inviterName} invited you to join{' '}
            <span className="font-semibold text-gray-900">
              {link.campaign.name}
            </span>{' '}
            as a player.
          </p>
        </div>
        <AcceptButton token={token} campaignId={link.campaignId} />
        <Link href="/campaigns" className="block">
          <Button variant="outline" className="w-full">
            Not now
          </Button>
        </Link>
      </div>
    </div>
  );
}
