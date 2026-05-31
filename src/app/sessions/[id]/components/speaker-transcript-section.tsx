'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, Tag, Check, X, Sparkles, Users, RefreshCw, Upload as UploadIcon } from 'lucide-react';
import { TranscriptSection } from './transcript-section';
import { uploadFileToBlob } from '@/lib/uploadToBlob';
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
  campaignId: string;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function SpeakerTranscriptSection({ sessionId, transcriptions, sessionStatus, campaignId }: Props) {
  const { data } = useSpeakerData(sessionId);

  // Fall back to the basic-mode transcript (with relabeling) until a
  // speaker-labeled run completes. Owners additionally get the on-demand
  // "identify speakers" bridge above the transcript.
  if (!hasSpeakerView(data)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {data?.canTag && <DiarizeBridge sessionId={sessionId} diarizationStatus={data.diarizationStatus} />}
        <TranscriptSection
          transcriptions={transcriptions}
          sessionStatus={sessionStatus}
          sessionId={sessionId}
          campaignId={campaignId}
        />
      </div>
    );
  }
  return <SpeakerView sessionId={sessionId} data={data!} />;
}

/**
 * Owner-only control to start (or retry) diarization on a basic-mode session,
 * with a re-upload affordance for when the recording's audio has been purged by
 * the retention cron.
 */
function DiarizeBridge({
  sessionId,
  diarizationStatus,
}: {
  sessionId: string;
  diarizationStatus: string;
}) {
  const queryClient = useQueryClient();
  const [needsReupload, setNeedsReupload] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['speakers', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
  };

  const diarize = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/diarize`, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Failed to start diarization');
      return j;
    },
    onSuccess: () => {
      setNeedsReupload(false);
      invalidate();
    },
    onError: (e: Error) => {
      // The most common failure is purged audio — offer a re-upload path.
      if (/no longer available|re-upload/i.test(e.message)) setNeedsReupload(true);
    },
  });

  const reupload = useMutation({
    mutationFn: async (file: File) => {
      const blob = await uploadFileToBlob(file, (f) => setProgress(f));
      const res = await fetch(`/api/sessions/${sessionId}/reupload-audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(blob),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Failed to re-upload audio');
      return j;
    },
    onSuccess: () => {
      setProgress(null);
      setNeedsReupload(false);
      diarize.mutate();
    },
    onError: () => setProgress(null),
  });

  const inProgress = diarizationStatus === 'queued' || diarizationStatus === 'running';

  return (
    <div
      style={{
        background: 'var(--sp-primary-tint)',
        border: '1px solid var(--sp-border)',
        borderRadius: 6,
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Users className="w-4 h-4" style={{ color: 'var(--sp-primary)' }} />
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--sp-fg-1)' }}>
          Identify speakers
        </span>
        {inProgress ? (
          <span style={{ fontSize: 12, color: 'var(--sp-fg-3)' }}>
            Diarization in progress…
          </span>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--sp-fg-3)' }}>
            Run voice diarization to attribute each line to a speaker.
            {diarizationStatus === 'failed' && ' The last run failed — you can retry.'}
          </span>
        )}
        {!inProgress && !needsReupload && (
          <button
            type="button"
            onClick={() => diarize.mutate()}
            disabled={diarize.isPending}
            style={tagBtnStyle}
          >
            {diarizationStatus === 'failed' ? 'Retry diarization' : 'Identify speakers'}
          </button>
        )}
      </div>

      {needsReupload && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--sp-fg-2)' }}>
            This session&apos;s audio has been purged. Re-upload the original recording to diarize:
          </span>
          <label style={{ ...tagBtnStyle, cursor: reupload.isPending ? 'default' : 'pointer' }}>
            <UploadIcon className="w-3 h-3" />
            {reupload.isPending
              ? `Uploading${progress != null ? ` ${Math.round(progress * 100)}%` : ''}…`
              : 'Choose audio file'}
            <input
              type="file"
              accept="audio/*"
              disabled={reupload.isPending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) reupload.mutate(file);
              }}
              style={{ display: 'none' }}
            />
          </label>
        </div>
      )}

      {diarize.isError && !needsReupload && (
        <span style={{ fontSize: 11, color: 'var(--sp-danger, #b91c1c)' }}>{diarize.error.message}</span>
      )}
      {reupload.isError && (
        <span style={{ fontSize: 11, color: 'var(--sp-danger, #b91c1c)' }}>{reupload.error.message}</span>
      )}
    </div>
  );
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
  const hasUnknownClusters = data.clusters.some((c) => !c.voiceSampleId);

  return (
    <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {data.canTag && hasUnknownClusters && (
        <RematchControl sessionId={sessionId} onMatched={invalidate} />
      )}

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

function RematchControl({ sessionId, onMatched }: { sessionId: string; onMatched: () => void }) {
  const [result, setResult] = useState<string | null>(null);

  const rematch = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/rematch`, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Failed to re-run matching');
      return j as { linked: unknown[] };
    },
    onSuccess: (j) => {
      const n = j.linked.length;
      setResult(n === 0 ? 'No new matches found.' : `Matched ${n} more speaker${n === 1 ? '' : 's'}.`);
      if (n > 0) onMatched();
    },
    onError: (e: Error) => setResult(e.message),
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <button type="button" onClick={() => rematch.mutate()} disabled={rematch.isPending} style={tagBtnStyle}>
        <RefreshCw className="w-3 h-3" /> {rematch.isPending ? 'Matching…' : 'Re-run matching'}
      </button>
      <span style={{ fontSize: 12, color: 'var(--sp-fg-3)' }}>
        Apply the voices you&apos;ve tagged to the remaining unknown speakers.
      </span>
      {result && <span style={{ fontSize: 12, color: 'var(--sp-fg-2)' }}>{result}</span>}
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
  const [useForTraining, setUseForTraining] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tag = useMutation({
    mutationFn: async (body: { voiceSampleId?: string; name?: string; useForTraining?: boolean }) => {
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
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
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
            onChange={(e) => e.target.value && tag.mutate({ voiceSampleId: e.target.value, useForTraining })}
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
            onClick={() => newName.trim() && tag.mutate({ name: newName.trim(), useForTraining })}
            disabled={tag.isPending || !newName.trim()}
            style={tagBtnStyle}
          >
            Save
          </button>
          <label
            title="Fold this clip into the matched voice so future sessions recognize it. Turn off for a noisy or very short clip."
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--sp-fg-3)' }}
          >
            <input
              type="checkbox"
              checked={useForTraining}
              onChange={(e) => setUseForTraining(e.target.checked)}
              disabled={tag.isPending}
            />
            Use for training
          </label>
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
