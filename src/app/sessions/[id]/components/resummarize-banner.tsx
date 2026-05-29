'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { useSpeakerData } from '../hooks/use-speaker-data';

interface CostEstimate {
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Banner shown in the Summary tab when speaker tagging has changed since the
 * summary was last generated. Opens a dialog with a cost estimate before
 * re-running the speaker-aware summary.
 */
export function ResummarizeBanner({ sessionId }: { sessionId: string }) {
  const { data: speaker } = useSpeakerData(sessionId);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const costQuery = useQuery<{ estimate: CostEstimate | null }>({
    queryKey: ['summary-cost', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/summary/${sessionId}/cost`);
      if (!res.ok) throw new Error('Failed to load cost estimate');
      return res.json();
    },
    enabled: open,
  });

  const regenerate = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/summary/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerate: true }),
      });
      if (!res.ok) throw new Error('Failed to regenerate summary');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['summary', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['speakers', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      setOpen(false);
    },
  });

  if (!speaker?.needsResummarize || !speaker.canTag) return null;

  const estimate = costQuery.data?.estimate;

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'var(--sp-warning-tint, #fef3c7)',
          border: '1px solid var(--sp-border)',
          borderRadius: 6,
          padding: '10px 16px',
          marginBottom: 14,
        }}
      >
        <AlertTriangle className="w-4 h-4" style={{ color: 'var(--sp-warning, #b45309)' }} />
        <span style={{ fontSize: 13, color: 'var(--sp-fg-2)', flex: 1 }}>
          Speaker tags changed since this summary was generated.
        </span>
        <button type="button" onClick={() => setOpen(true)} style={primaryBtnStyle}>
          <RefreshCw className="w-3 h-3" /> Re-summarize
        </button>
      </div>

      {open && (
        <div style={overlayStyle} onClick={() => !regenerate.isPending && setOpen(false)}>
          <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--sp-fg-1)', margin: 0 }}>
              Re-generate speaker-aware summary?
            </h3>
            <div style={{ fontSize: 13, color: 'var(--sp-fg-2)', margin: '12px 0' }}>
              {costQuery.isLoading ? (
                'Estimating cost…'
              ) : estimate ? (
                <>
                  Estimated cost: <strong>${estimate.costUsd.toFixed(4)}</strong> using{' '}
                  {estimate.provider}/{estimate.modelId} (~{estimate.inputTokens.toLocaleString()} input
                  tokens).
                </>
              ) : (
                'Cost estimate unavailable for the configured model.'
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={regenerate.isPending}
                style={secondaryBtnStyle}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => regenerate.mutate()}
                disabled={regenerate.isPending}
                style={primaryBtnStyle}
              >
                {regenerate.isPending ? 'Generating…' : 'Confirm & re-summarize'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const primaryBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 13,
  padding: '6px 12px',
  borderRadius: 4,
  border: '1px solid var(--sp-primary)',
  background: 'var(--sp-primary)',
  color: '#fff',
  cursor: 'pointer',
};

const secondaryBtnStyle: React.CSSProperties = {
  fontSize: 13,
  padding: '6px 12px',
  borderRadius: 4,
  border: '1px solid var(--sp-border)',
  background: 'var(--sp-bg-surface)',
  color: 'var(--sp-fg-2)',
  cursor: 'pointer',
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 50,
};

const dialogStyle: React.CSSProperties = {
  background: 'var(--sp-bg-surface)',
  border: '1px solid var(--sp-border)',
  borderRadius: 8,
  boxShadow: 'var(--sp-shadow-card)',
  padding: '20px 24px',
  maxWidth: 440,
  width: '90%',
};
