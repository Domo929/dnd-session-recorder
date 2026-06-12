'use client';

import { useState, useMemo } from 'react';
import { FileText, Search, Pencil, Check, X, Users } from 'lucide-react';
import type { Transcription } from '../types';
import {
  parseSpeakerTurns,
  speakerColorIndex,
  buildTurns,
  resolveTurnName,
  type BasicTurn,
} from '@/lib/transcriptFormat';
import {
  useSpeakerLabels,
  useSpeakerRegistry,
  useUpdateSpeakerLabels,
} from '../hooks/use-speaker-labels';

// Accent colors for speaker labels, indexed by speakerColorIndex.
const SPEAKER_COLORS = [
  'var(--sp-fg-2)',
  'var(--sp-primary)',
  '#2f9e6b',
  '#b5793a',
  '#8a5cd1',
  '#c2526b',
];

interface TranscriptSectionProps {
  transcriptions: Transcription[];
  sessionStatus: string;
  /** When provided (basic mode), enables per-turn speaker relabeling. */
  sessionId?: string;
  campaignId?: string;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * TranscriptSection component displays the session transcript.
 *
 * Empty state shows an informational card (with spinner when transcribing).
 * Filled state shows a searchable transcript. When `sessionId`+`campaignId` are
 * provided it renders the relabel-aware basic-mode view (per-turn speaker names
 * with a campaign-wide registry); otherwise the plain timestamped table.
 */
export function TranscriptSection({
  transcriptions,
  sessionStatus,
  sessionId,
  campaignId,
}: TranscriptSectionProps) {
  const isTranscribing = sessionStatus === 'transcribing';

  // ── Empty state ──────────────────────────────────────────────
  if (transcriptions.length === 0) {
    return (
      <div style={{ marginTop: 18 }}>
        <div
          style={{
            background: 'var(--sp-bg-surface)',
            border: '1px solid var(--sp-border)',
            borderRadius: 6,
            boxShadow: 'var(--sp-shadow-card)',
            padding: '32px 28px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 16,
          }}
        >
          {/* Icon plate */}
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 6,
              background: 'var(--sp-primary-tint)',
              border: '1px solid var(--sp-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <FileText
              size={20}
              style={{
                color: 'var(--sp-primary)',
                animation: isTranscribing ? 'ss-spin 2s linear infinite' : 'none',
              }}
            />
          </div>

          <div>
            <div
              className="font-body"
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase' as const,
                color: 'var(--sp-fg-4)',
                marginBottom: 4,
              }}
            >
              Transcript
            </div>
            <h3
              className="font-display"
              style={{
                fontSize: 18,
                fontWeight: 600,
                color: 'var(--sp-fg-1)',
                margin: 0,
                lineHeight: 1.3,
              }}
            >
              {isTranscribing
                ? 'Transcribing in the background\u2026'
                : 'No transcript yet.'}
            </h3>
            <p
              className="font-body"
              style={{
                fontSize: 14,
                color: 'var(--sp-fg-3)',
                margin: '6px 0 0',
                lineHeight: 1.5,
              }}
            >
              {isTranscribing
                ? 'Audio is being split into chunks and sent to the transcription service. This page will update automatically.'
                : 'Upload an audio recording and start processing to generate a transcript.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (sessionId && campaignId) {
    return (
      <RelabelTranscript
        transcriptions={transcriptions}
        sessionId={sessionId}
        campaignId={campaignId}
      />
    );
  }

  return <PlainTranscript transcriptions={transcriptions} />;
}

// ── Plain timestamped table (diarized fallback / no relabeling) ─────────────
function PlainTranscript({ transcriptions }: { transcriptions: Transcription[] }) {
  const [searchQuery, setSearchQuery] = useState('');
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return transcriptions;
    const q = searchQuery.toLowerCase();
    return transcriptions.filter((t) => t.text.toLowerCase().includes(q));
  }, [transcriptions, searchQuery]);

  return (
    <div style={{ marginTop: 18 }}>
      <SearchInput value={searchQuery} onChange={setSearchQuery} />
      <div
        style={{
          background: 'var(--sp-bg-surface)',
          border: '1px solid var(--sp-border)',
          borderRadius: 6,
          boxShadow: 'var(--sp-shadow-card)',
          overflow: 'hidden',
        }}
      >
        {searchQuery.trim() && (
          <div
            className="font-body"
            style={{
              padding: '8px 16px',
              fontSize: 12,
              color: 'var(--sp-fg-3)',
              borderBottom: '1px solid var(--sp-divider)',
            }}
          >
            {filtered.length} of {transcriptions.length} segments
          </div>
        )}
        <div style={{ maxHeight: 480, overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <NoMatches />
          ) : (
            filtered.map((t, index) => (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 16,
                  padding: '10px 16px',
                  background: index % 2 === 1 ? 'var(--sp-bg-sunken)' : 'transparent',
                  borderBottom:
                    index < filtered.length - 1 ? '1px solid var(--sp-divider)' : 'none',
                }}
              >
                <span
                  className="font-mono"
                  style={{
                    fontSize: 12,
                    color: 'var(--sp-fg-4)',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    paddingTop: 2,
                    minWidth: 90,
                  }}
                >
                  {formatTime(t.startTime)} - {formatTime(t.endTime)}
                </span>
                <div
                  className="font-body"
                  style={{
                    fontSize: 14,
                    color: 'var(--sp-fg-2)',
                    lineHeight: 1.55,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    flex: 1,
                  }}
                >
                  {parseSpeakerTurns(t.text).map((turn, ti) => (
                    <p key={ti} style={{ margin: 0 }}>
                      {turn.speaker && (
                        <span
                          style={{
                            fontWeight: 600,
                            marginRight: 6,
                            color:
                              SPEAKER_COLORS[
                                speakerColorIndex(turn.speaker, SPEAKER_COLORS.length)
                              ],
                          }}
                        >
                          {turn.speaker}:
                        </span>
                      )}
                      {turn.text}
                    </p>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Editable basic-mode relabel view ───────────────────────────────────────
const REGISTRY_DATALIST_ID = 'speaker-registry-options';

function RelabelTranscript({
  transcriptions,
  sessionId,
  campaignId,
}: {
  transcriptions: Transcription[];
  sessionId: string;
  campaignId: string;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const { data: labels } = useSpeakerLabels(sessionId);
  const { data: registry } = useSpeakerRegistry(campaignId);
  const save = useUpdateSpeakerLabels(sessionId, campaignId);

  const canEdit = labels?.canEdit ?? false;
  const turns = useMemo(() => buildTurns(transcriptions), [transcriptions]);

  const defaultMap = useMemo(
    () => Object.fromEntries((labels?.defaults ?? []).map((d) => [d.speakerKey, d.name])),
    [labels],
  );
  const overrideMap = useMemo(
    () => Object.fromEntries((labels?.turns ?? []).map((t) => [t.turnIndex, t.name])),
    [labels],
  );

  // Distinct speaker keys, in first-appearance order, for the defaults panel.
  const speakerKeys = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of turns) {
      if (t.speakerKey && !seen.has(t.speakerKey)) {
        seen.add(t.speakerKey);
        out.push(t.speakerKey);
      }
    }
    return out;
  }, [turns]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return turns;
    const q = searchQuery.toLowerCase();
    return turns.filter((t) => t.text.toLowerCase().includes(q));
  }, [turns, searchQuery]);

  return (
    <div style={{ marginTop: 18 }}>
      <datalist id={REGISTRY_DATALIST_ID}>
        {(registry ?? []).map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      {canEdit && speakerKeys.length > 0 && (
        <DefaultsPanel
          speakerKeys={speakerKeys}
          defaultMap={defaultMap}
          disabled={save.isPending}
          onSave={(speakerKey, name) => save.mutate({ defaults: [{ speakerKey, name }] })}
        />
      )}

      <SearchInput value={searchQuery} onChange={setSearchQuery} />

      <div
        style={{
          background: 'var(--sp-bg-surface)',
          border: '1px solid var(--sp-border)',
          borderRadius: 6,
          boxShadow: 'var(--sp-shadow-card)',
          overflow: 'hidden',
        }}
      >
        {searchQuery.trim() && (
          <div
            className="font-body"
            style={{
              padding: '8px 16px',
              fontSize: 12,
              color: 'var(--sp-fg-3)',
              borderBottom: '1px solid var(--sp-divider)',
            }}
          >
            {filtered.length} of {turns.length} lines
          </div>
        )}
        <div style={{ maxHeight: 560, overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <NoMatches />
          ) : (
            filtered.map((turn, index) => (
              <TurnRow
                key={turn.turnIndex}
                turn={turn}
                striped={index % 2 === 1}
                resolvedName={resolveTurnName(turn, defaultMap, overrideMap)}
                hasOverride={overrideMap[turn.turnIndex] != null}
                canEdit={canEdit}
                disabled={save.isPending}
                onSave={(name) => save.mutate({ turns: [{ turnIndex: turn.turnIndex, name }] })}
              />
            ))
          )}
        </div>
      </div>
      {save.isError && (
        <p style={{ fontSize: 12, color: 'var(--sp-danger, #b91c1c)', marginTop: 8 }}>
          {(save.error as Error).message}
        </p>
      )}
    </div>
  );
}

function DefaultsPanel({
  speakerKeys,
  defaultMap,
  disabled,
  onSave,
}: {
  speakerKeys: string[];
  defaultMap: Record<string, string>;
  disabled: boolean;
  onSave: (speakerKey: string, name: string) => void;
}) {
  return (
    <div
      style={{
        background: 'var(--sp-primary-tint)',
        border: '1px solid var(--sp-border)',
        borderRadius: 6,
        padding: '12px 16px',
        marginBottom: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <Users size={15} style={{ color: 'var(--sp-primary)' }} />
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--sp-fg-1)' }}>
          Name the speakers
        </span>
        <span style={{ fontSize: 12, color: 'var(--sp-fg-3)' }}>
          Sets a default for every line; override individual lines below.
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {speakerKeys.map((key) => (
          <DefaultField
            key={key}
            speakerKey={key}
            current={defaultMap[key] ?? ''}
            disabled={disabled}
            onSave={(name) => onSave(key, name)}
          />
        ))}
      </div>
    </div>
  );
}

function DefaultField({
  speakerKey,
  current,
  disabled,
  onSave,
}: {
  speakerKey: string;
  current: string;
  disabled: boolean;
  onSave: (name: string) => void;
}) {
  const [value, setValue] = useState(current);
  const dirty = value.trim() !== current.trim();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--sp-fg-3)', minWidth: 64 }}>{speakerKey}</span>
      <input
        list={REGISTRY_DATALIST_ID}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && dirty) onSave(value.trim());
        }}
        placeholder="name…"
        disabled={disabled}
        style={inputStyle}
      />
      {dirty && (
        <button
          type="button"
          onClick={() => onSave(value.trim())}
          disabled={disabled}
          style={iconBtnStyle}
          title="Save default"
        >
          <Check size={14} />
        </button>
      )}
    </div>
  );
}

function TurnRow({
  turn,
  striped,
  resolvedName,
  hasOverride,
  canEdit,
  disabled,
  onSave,
}: {
  turn: BasicTurn;
  striped: boolean;
  resolvedName: string | null;
  hasOverride: boolean;
  canEdit: boolean;
  disabled: boolean;
  onSave: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(resolvedName ?? '');

  const labelColor = SPEAKER_COLORS[speakerColorIndex(turn.speakerKey, SPEAKER_COLORS.length)];

  const commit = (name: string) => {
    onSave(name);
    setEditing(false);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 16px',
        background: striped ? 'var(--sp-bg-sunken)' : 'transparent',
        borderBottom: '1px solid var(--sp-divider)',
      }}
    >
      <div style={{ minWidth: 150, flexShrink: 0 }}>
        {editing ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <input
              list={REGISTRY_DATALIST_ID}
              value={value}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit(value.trim());
                if (e.key === 'Escape') setEditing(false);
              }}
              placeholder={turn.speakerKey ?? 'name…'}
              disabled={disabled}
              style={inputStyle}
            />
            <button type="button" onClick={() => commit(value.trim())} disabled={disabled} style={iconBtnStyle} title="Save">
              <Check size={14} />
            </button>
            <button type="button" onClick={() => setEditing(false)} style={iconBtnStyle} title="Cancel">
              <X size={14} />
            </button>
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: resolvedName ? labelColor : 'var(--sp-fg-4)' }}>
              {resolvedName ?? '—'}
            </span>
            {hasOverride && (
              <span
                style={{ fontSize: 10, color: 'var(--sp-fg-4)', border: '1px solid var(--sp-border)', borderRadius: 4, padding: '0 4px' }}
                title="This line overrides the speaker default"
              >
                line
              </span>
            )}
            {canEdit && turn.speakerKey && (
              <button
                type="button"
                onClick={() => {
                  setValue(resolvedName ?? '');
                  setEditing(true);
                }}
                style={iconBtnStyle}
                title="Rename this line"
              >
                <Pencil size={12} />
              </button>
            )}
          </span>
        )}
      </div>
      <div className="font-body" style={{ fontSize: 14, color: 'var(--sp-fg-2)', lineHeight: 1.55, flex: 1 }}>
        {turn.text}
      </div>
    </div>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────────
function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ position: 'relative', marginBottom: 12 }}>
      <Search
        size={16}
        style={{
          position: 'absolute',
          left: 12,
          top: '50%',
          transform: 'translateY(-50%)',
          color: 'var(--sp-fg-4)',
          pointerEvents: 'none',
        }}
      />
      <input
        type="text"
        placeholder={'Search transcript\u2026'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-body"
        style={{
          width: '100%',
          padding: '8px 12px 8px 36px',
          fontSize: 14,
          background: 'var(--sp-bg-surface)',
          border: '1px solid var(--sp-border)',
          borderRadius: 6,
          color: 'var(--sp-fg-1)',
          outline: 'none',
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = 'var(--sp-primary)';
          e.currentTarget.style.boxShadow = '0 0 0 3px var(--sp-primary-tint)';
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = 'var(--sp-border)';
          e.currentTarget.style.boxShadow = 'none';
        }}
      />
    </div>
  );
}

function NoMatches() {
  return (
    <div
      className="font-body"
      style={{
        padding: '24px 16px',
        textAlign: 'center',
        color: 'var(--sp-fg-3)',
        fontSize: 14,
      }}
    >
      No lines match your search.
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 5px',
  borderRadius: 4,
  border: '1px solid var(--sp-border)',
  background: 'var(--sp-bg-surface)',
  color: 'var(--sp-fg-3)',
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  fontSize: 13,
  padding: '3px 8px',
  borderRadius: 4,
  border: '1px solid var(--sp-border)',
  background: 'var(--sp-bg-surface)',
  color: 'var(--sp-fg-1)',
  width: 120,
};
