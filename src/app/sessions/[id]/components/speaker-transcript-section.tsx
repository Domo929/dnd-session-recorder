'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, Tag, Check, X, Sparkles } from 'lucide-react';
import { TranscriptSection } from './transcript-section';
import type { Transcription } from '../types';
import {
  useSpeakerData,
  hasSpeakerView,
  type SpeakerCluster,
  type SpeakerData,
} from '../hooks/use-speaker-data';

interface Props {
  sessionId: string;
  transcriptions: Transcription[];
  sessionStatus: string;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function SpeakerTranscriptSection({ sessionId, transcriptions, sessionStatus }: Props) {
  const { data } = useSpeakerData(sessionId);

  // Fall back to the plain transcript until a speaker-labeled run completes.
  if (!hasSpeakerView(data)) {
    return <TranscriptSection transcriptions={transcriptions} sessionStatus={sessionStatus} />;
  }
  return <SpeakerView sessionId={sessionId} data={data!} />;
}

function SpeakerView({ sessionId, data }: { sessionId: string; data: SpeakerData }) {
  const queryClient = useQueryClient();
  const clusterById = useMemo(
    () => new Map(data.clusters.map((c) => [c.id, c])),
    [data.clusters],
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['speakers', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['summary', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
  };

  const pendingSuggestions = data.clusters.filter(
    (c) => c.npcSuggestion && c.npcSuggestion.status === 'pending',
  );

  return (
    <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {data.canTag && pendingSuggestions.length > 0 && (
        <NpcSuggestionsPanel suggestions={pendingSuggestions} onResolved={invalidate} />
      )}

      <div
        style={{
          background: 'var(--sp-bg-surface)',
          border: '1px solid var(--sp-border)',
          borderRadius: 6,
          boxShadow: 'var(--sp-shadow-card)',
          padding: '8px 0',
        }}
      >
        {data.turns.map((turn, i) => {
          const cluster = turn.speakerClusterId ? clusterById.get(turn.speakerClusterId) : undefined;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: 12,
                padding: '10px 20px',
                borderTop: i === 0 ? 'none' : '1px solid var(--sp-border)',
              }}
            >
              <div style={{ width: 52, flexShrink: 0, color: 'var(--sp-fg-3)', fontSize: 12, paddingTop: 2 }}>
                {formatTime(turn.startTime)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--sp-fg-1)' }}>
                    {cluster?.displayLabel ?? 'Unknown speaker'}
                  </span>
                  {cluster?.matchConfidence === 'low' && (
                    <span style={{ fontSize: 11, color: 'var(--sp-fg-3)' }}>(uncertain)</span>
                  )}
                  {data.canTag && cluster && !cluster.voiceSampleId && (
                    <TagControls cluster={cluster} voiceOptions={data.voiceOptions} onTagged={invalidate} />
                  )}
                </div>
                <div style={{ fontSize: 14, color: 'var(--sp-fg-2)', lineHeight: 1.5 }}>{turn.text}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TagControls({
  cluster,
  voiceOptions,
  onTagged,
}: {
  cluster: SpeakerCluster;
  voiceOptions: { id: string; label: string }[];
  onTagged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const tag = useMutation({
    mutationFn: async (body: { voiceSampleId?: string; name?: string }) => {
      const res = await fetch(`/api/clusters/${cluster.id}/tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to tag');
      }
      return res.json();
    },
    onSuccess: () => {
      setOpen(false);
      setNewName('');
      setError(null);
      onTagged();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {cluster.snippetAvailable && (
        <button
          type="button"
          onClick={() => new Audio(`/api/clusters/${cluster.id}/snippet`).play()}
          title="Play snippet"
          style={iconBtnStyle}
        >
          <Play className="w-3 h-3" />
        </button>
      )}
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} style={tagBtnStyle}>
          <Tag className="w-3 h-3" /> Tag voice
        </button>
      ) : (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <select
            defaultValue=""
            onChange={(e) => e.target.value && tag.mutate({ voiceSampleId: e.target.value })}
            disabled={tag.isPending}
            style={selectStyle}
          >
            <option value="" disabled>
              Maybe one of these?
            </option>
            {voiceOptions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New name…"
            disabled={tag.isPending}
            style={inputStyle}
          />
          <button
            type="button"
            onClick={() => newName.trim() && tag.mutate({ name: newName.trim() })}
            disabled={tag.isPending || !newName.trim()}
            style={tagBtnStyle}
          >
            Save
          </button>
          <button type="button" onClick={() => setOpen(false)} style={iconBtnStyle}>
            <X className="w-3 h-3" />
          </button>
          {error && <span style={{ fontSize: 11, color: 'var(--sp-danger, #b91c1c)' }}>{error}</span>}
        </span>
      )}
    </span>
  );
}

function NpcSuggestionsPanel({
  suggestions,
  onResolved,
}: {
  suggestions: SpeakerCluster[];
  onResolved: () => void;
}) {
  return (
    <div
      style={{
        background: 'var(--sp-primary-tint)',
        border: '1px solid var(--sp-border)',
        borderRadius: 6,
        padding: '14px 18px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Sparkles className="w-4 h-4" style={{ color: 'var(--sp-primary)' }} />
        <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--sp-fg-1)' }}>Suggested NPC names</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {suggestions.map((c) => (
          <NpcSuggestionRow key={c.id} cluster={c} onResolved={onResolved} />
        ))}
      </div>
    </div>
  );
}

function NpcSuggestionRow({ cluster, onResolved }: { cluster: SpeakerCluster; onResolved: () => void }) {
  const s = cluster.npcSuggestion!;
  const [name, setName] = useState(s.suggestedName);
  const [error, setError] = useState<string | null>(null);

  const resolve = useMutation({
    mutationFn: async (body: { action: 'accept' | 'reject'; name?: string }) => {
      const res = await fetch(`/api/npc-suggestions/${s.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Failed');
      }
      return res.json();
    },
    onSuccess: onResolved,
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ color: 'var(--sp-fg-2)' }}>
        <strong style={{ color: 'var(--sp-fg-1)' }}>{cluster.displayLabel}</strong> →{' '}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={resolve.isPending}
          style={{ ...inputStyle, minWidth: 140 }}
        />{' '}
        <span style={{ fontSize: 11, color: 'var(--sp-fg-3)' }}>({s.confidence})</span>
      </div>
      <div style={{ color: 'var(--sp-fg-3)', fontSize: 12, margin: '4px 0' }}>{s.reasoning}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={() => resolve.mutate({ action: 'accept', name: name.trim() || undefined })}
          disabled={resolve.isPending}
          style={tagBtnStyle}
        >
          <Check className="w-3 h-3" /> Accept
        </button>
        <button
          type="button"
          onClick={() => resolve.mutate({ action: 'reject' })}
          disabled={resolve.isPending}
          style={iconBtnStyle}
        >
          <X className="w-3 h-3" /> Reject
        </button>
        {error && <span style={{ fontSize: 11, color: 'var(--sp-danger, #b91c1c)' }}>{error}</span>}
      </div>
    </div>
  );
}

const tagBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid var(--sp-border)',
  background: 'var(--sp-bg-surface)',
  color: 'var(--sp-primary)',
  cursor: 'pointer',
};

const iconBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
  padding: '2px 6px',
  borderRadius: 4,
  border: '1px solid var(--sp-border)',
  background: 'var(--sp-bg-surface)',
  color: 'var(--sp-fg-3)',
  cursor: 'pointer',
};

const selectStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '2px 6px',
  borderRadius: 4,
  border: '1px solid var(--sp-border)',
  background: 'var(--sp-bg-surface)',
  color: 'var(--sp-fg-2)',
};

const inputStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '2px 6px',
  borderRadius: 4,
  border: '1px solid var(--sp-border)',
  background: 'var(--sp-bg-surface)',
  color: 'var(--sp-fg-2)',
  width: 110,
};
