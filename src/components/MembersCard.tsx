'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, Trash2, X } from 'lucide-react';
import Button from '@/components/ui/Button';

interface Member {
  userId: string;
  name: string;
  email: string | null;
  role: 'owner' | 'player';
  joinedAt: string;
  isSelf: boolean;
}

interface PendingInvitation {
  id: string;
  email: string;
  createdAt: string;
}

interface MembersResponse {
  members: Member[];
  pendingInvitations: PendingInvitation[];
  viewerRole: 'owner' | 'player';
}

type InviteStatus =
  | { kind: 'added'; member: Member }
  | { kind: 'already_member'; member: Member }
  | { kind: 'pending'; email: string }
  | { kind: 'self'; message: string }
  | { kind: 'error'; message: string };

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function roleBadgeClasses(role: 'owner' | 'player') {
  return role === 'owner'
    ? 'bg-green-100 text-green-800 border-green-200'
    : 'bg-blue-100 text-blue-800 border-blue-200';
}

export default function MembersCard({ campaignId }: { campaignId: string }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [inviteStatus, setInviteStatus] = useState<InviteStatus | null>(null);

  const { data, isLoading, isError } = useQuery<MembersResponse>({
    queryKey: ['members', campaignId],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/${campaignId}/members`);
      if (!res.ok) throw new Error('Failed to fetch members');
      return res.json();
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await fetch(
        `/api/campaigns/${campaignId}/members/${userId}`,
        { method: 'DELETE' },
      );
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to remove member');
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members', campaignId] });
    },
  });

  const cancelInvitationMutation = useMutation({
    mutationFn: async (invitationId: string) => {
      const res = await fetch(
        `/api/campaigns/${campaignId}/invitations/${invitationId}`,
        { method: 'DELETE' },
      );
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to cancel invitation');
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members', campaignId] });
    },
  });

  const inviteMutation = useMutation({
    mutationFn: async (inviteEmail: string) => {
      const res = await fetch(`/api/campaigns/${campaignId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 200 && res.status !== 201) {
        if (body.status === 'self') {
          return { ok: false as const, body };
        }
        return {
          ok: false as const,
          body: { error: body.error || 'Request failed' },
        };
      }
      return { ok: true as const, body };
    },
    onSuccess: (result) => {
      if (!result.ok) {
        if (result.body.status === 'self') {
          setInviteStatus({ kind: 'self', message: result.body.message });
        } else {
          setInviteStatus({
            kind: 'error',
            message: result.body.error || 'Request failed',
          });
        }
        return;
      }
      const body = result.body;
      if (body.status === 'added') {
        setInviteStatus({ kind: 'added', member: body.member });
        setEmail('');
        queryClient.invalidateQueries({ queryKey: ['members', campaignId] });
      } else if (body.status === 'already_member') {
        setInviteStatus({ kind: 'already_member', member: body.member });
      } else if (body.status === 'pending') {
        setInviteStatus({ kind: 'pending', email: body.invitation.email });
        setEmail('');
        queryClient.invalidateQueries({ queryKey: ['members', campaignId] });
      } else if (body.status === 'self') {
        setInviteStatus({ kind: 'self', message: body.message });
      }
    },
    onError: (err: Error) => {
      setInviteStatus({
        kind: 'error',
        message: err.message || 'Request failed',
      });
    },
  });

  const handleRemove = (member: Member) => {
    if (window.confirm(`Remove ${member.name} from this campaign?`)) {
      removeMutation.mutate(member.userId);
    }
  };

  const handleInviteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    inviteMutation.mutate(email.trim());
  };

  const renderStatus = () => {
    if (!inviteStatus) return null;
    switch (inviteStatus.kind) {
      case 'added':
        return (
          <p className="text-sm text-green-700">
            Added {inviteStatus.member.name}
            {inviteStatus.member.email ? ` (${inviteStatus.member.email})` : ''} as
            a player.
          </p>
        );
      case 'already_member':
        return (
          <p className="text-sm text-gray-600">
            {inviteStatus.member.name} is already a member.
          </p>
        );
      case 'pending':
        return (
          <p className="text-sm text-blue-700">
            {inviteStatus.email} doesn&apos;t have an account yet. They&apos;ll be
            added automatically when they sign up.
          </p>
        );
      case 'self':
        return <p className="text-sm text-red-600">{inviteStatus.message}</p>;
      case 'error':
        return (
          <p className="text-sm text-red-600">
            Couldn&apos;t send invite: {inviteStatus.message}
          </p>
        );
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center space-x-2 mb-4">
        <Users className="h-5 w-5 text-gray-700" />
        <h2 className="text-lg font-semibold text-gray-900">Members</h2>
      </div>

      {isLoading ? (
        <div className="flex items-center space-x-2 py-4">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
          <span className="text-sm text-gray-500">Loading members...</span>
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-red-600">Failed to load members.</p>
      ) : (
        <>
          <ul className="divide-y divide-gray-100">
            {data.members.map((member) => {
              const isOwnerViewer = data.viewerRole === 'owner';
              const canRemove = isOwnerViewer && member.role !== 'owner';
              return (
                <li
                  key={member.userId}
                  className="flex items-start justify-between py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center space-x-2 flex-wrap">
                      <span className="font-medium text-gray-900">
                        {member.name}
                      </span>
                      {member.isSelf && member.role === 'owner' && (
                        <span className="text-xs text-gray-500">(you)</span>
                      )}
                      <span
                        className={`px-2 py-0.5 rounded-full border text-xs font-medium ${roleBadgeClasses(member.role)}`}
                      >
                        {member.role === 'owner' ? 'Owner' : 'Player'}
                      </span>
                    </div>
                    {isOwnerViewer && member.email && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        {member.email}
                      </p>
                    )}
                    <p className="text-xs text-gray-400 mt-0.5">
                      Joined {formatDate(member.joinedAt)}
                    </p>
                  </div>
                  {canRemove && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRemove(member)}
                      disabled={removeMutation.isPending}
                      className="flex items-center space-x-1 text-red-600 hover:text-red-700 hover:bg-red-50 hover:border-red-200"
                    >
                      <Trash2 className="h-3 w-3" />
                      <span>Remove</span>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>

          {data.viewerRole === 'owner' &&
            data.pendingInvitations.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-2">
                  Pending invitations
                </h3>
                <ul className="divide-y divide-gray-100">
                  {data.pendingInvitations.map((inv) => (
                    <li
                      key={inv.id}
                      className="flex items-center justify-between py-2"
                    >
                      <div>
                        <p className="text-sm text-gray-900">{inv.email}</p>
                        <p className="text-xs text-gray-400">
                          Invited {formatDate(inv.createdAt)}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => cancelInvitationMutation.mutate(inv.id)}
                        disabled={cancelInvitationMutation.isPending}
                        className="flex items-center space-x-1 text-red-600 hover:text-red-700 hover:bg-red-50 hover:border-red-200"
                      >
                        <X className="h-3 w-3" />
                        <span>Cancel</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

          {data.viewerRole === 'owner' && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">
                Invite by email
              </h3>
              <form
                onSubmit={handleInviteSubmit}
                className="flex flex-col sm:flex-row gap-2"
              >
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="person@example.com"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
                <Button
                  type="submit"
                  disabled={inviteMutation.isPending || !email.trim()}
                >
                  {inviteMutation.isPending ? 'Sending...' : 'Send invite'}
                </Button>
              </form>
              <div className="mt-2 min-h-[1.25rem]">{renderStatus()}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
