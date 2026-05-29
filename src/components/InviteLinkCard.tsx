'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link as LinkIcon, Copy, RefreshCw, Trash2 } from 'lucide-react';
import Button from '@/components/ui/Button';

interface InviteLinkMeta {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
}

interface InviteLinkResponse {
  link: InviteLinkMeta | null;
}

interface GeneratedLink {
  id: string;
  url: string;
  createdAt: string;
  expiresAt: string | null;
}

function formatRelativeExpiry(expiresAt: string | null): string {
  if (!expiresAt) return 'Never expires.';
  const date = new Date(expiresAt);
  return `Expires ${date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

export default function InviteLinkCard({
  campaignId,
}: {
  campaignId: string;
}) {
  const queryClient = useQueryClient();
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [expiresInDays, setExpiresInDays] = useState<number>(30);
  const [copied, setCopied] = useState(false);

  const { data, isLoading, isError } = useQuery<InviteLinkResponse>({
    queryKey: ['invite-link', campaignId],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/${campaignId}/invite-link`);
      if (!res.ok) throw new Error('Failed to fetch invite link');
      return res.json();
    },
  });

  const generateMutation = useMutation({
    mutationFn: async (): Promise<{ link: GeneratedLink }> => {
      const res = await fetch(`/api/campaigns/${campaignId}/invite-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expiresInDays: expiresInDays === 0 ? null : expiresInDays,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to generate invite link');
      }
      return res.json();
    },
    onSuccess: (result) => {
      setGeneratedUrl(result.link.url);
      setCopied(false);
      queryClient.invalidateQueries({ queryKey: ['invite-link', campaignId] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/campaigns/${campaignId}/invite-link`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to revoke invite link');
      }
    },
    onSuccess: () => {
      setGeneratedUrl(null);
      setCopied(false);
      queryClient.invalidateQueries({ queryKey: ['invite-link', campaignId] });
    },
  });

  const handleCopy = async () => {
    if (!generatedUrl) return;
    try {
      await navigator.clipboard.writeText(generatedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* swallow — clipboard may be unavailable */
    }
  };

  const handleGenerateNew = () => {
    if (
      window.confirm(
        'Generate a new link? The current one will be invalidated.',
      )
    ) {
      generateMutation.mutate();
    }
  };

  const handleRevoke = () => {
    if (window.confirm('Revoke the current invite link?')) {
      revokeMutation.mutate();
    }
  };

  const serverLink = data?.link ?? null;
  const hasActiveLink = generatedUrl !== null || serverLink !== null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center space-x-2 mb-2">
        <LinkIcon className="h-5 w-5 text-gray-700" />
        <h2 className="text-lg font-semibold text-gray-900">Invite link</h2>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Anyone with this link can join as a player. Generate a new link to
        invalidate the old one.
      </p>

      {isLoading ? (
        <div className="flex items-center space-x-2 py-4">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
          <span className="text-sm text-gray-500">Loading invite link...</span>
        </div>
      ) : isError ? (
        <p className="text-sm text-red-600">Failed to load invite link.</p>
      ) : !hasActiveLink ? (
        <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
          <label className="text-sm text-gray-700">Expires after</label>
          <select
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(Number(e.target.value))}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={0}>Never</option>
          </select>
          <Button
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
          >
            {generateMutation.isPending
              ? 'Generating...'
              : 'Generate invite link'}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {generatedUrl ? (
            <div>
              <p className="text-sm text-gray-700 mb-2">
                Copy this link now — it won&apos;t be shown again.
              </p>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={generatedUrl}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  variant="outline"
                  onClick={handleCopy}
                  className="flex items-center space-x-1"
                >
                  <Copy className="h-4 w-4" />
                  <span>{copied ? 'Copied!' : 'Copy'}</span>
                </Button>
              </div>
            </div>
          ) : serverLink ? (
            <div className="text-sm">
              <p className="text-gray-800 font-medium">Invite link is active.</p>
              {serverLink.expired ? (
                <p className="text-red-600">Link has expired</p>
              ) : (
                <p className="text-gray-500">
                  {formatRelativeExpiry(serverLink.expiresAt)}
                </p>
              )}
            </div>
          ) : null}

          <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
            <label className="text-sm text-gray-700">Expires after</label>
            <select
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(Number(e.target.value))}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={0}>Never</option>
            </select>
            <Button
              variant="outline"
              onClick={handleGenerateNew}
              disabled={generateMutation.isPending}
              className="flex items-center space-x-1 text-blue-600 hover:text-blue-700 hover:bg-blue-50 hover:border-blue-200"
            >
              <RefreshCw className="h-4 w-4" />
              <span>
                {generateMutation.isPending ? 'Generating...' : 'Generate new'}
              </span>
            </Button>
            <Button
              variant="outline"
              onClick={handleRevoke}
              disabled={revokeMutation.isPending}
              className="flex items-center space-x-1 text-red-600 hover:text-red-700 hover:bg-red-50 hover:border-red-200"
            >
              <Trash2 className="h-4 w-4" />
              <span>{revokeMutation.isPending ? 'Revoking...' : 'Revoke'}</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
