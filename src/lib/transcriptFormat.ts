/**
 * Formatting helpers for the **basic** (non-diarized) transcript.
 *
 * Basic-mode transcription saves the whole session as one text blob in which
 * the model prefixes each speaker turn inline with a label like `Speaker 1:`
 * (see GEMINI_TRANSCRIPTION_PROMPT in src/lib/ai.ts). Rendered verbatim that
 * is an unbroken wall of text. `parseSpeakerTurns` splits the blob back into
 * discrete turns so the UI can lay each one out on its own line with the
 * speaker label emphasized.
 *
 * Pure functions only — no DB or React.
 */

export interface SpeakerTurn {
  /** The speaker label without the trailing colon (e.g. `Speaker 1`), or null. */
  speaker: string | null;
  /** The spoken text for this turn, trimmed. */
  text: string;
}

// A speaker label at a turn boundary: `Speaker 1:`, `Speaker 2 :`, `Speaker A:`.
// `\b` is a zero-width word boundary so it never consumes the whitespace that
// separates back-to-back labels, and it won't match mid-word (e.g.
// "loudspeaker:"). Kept deliberately narrow (the literal word "Speaker" + a
// short token) so it doesn't swallow ordinary sentences that contain a colon.
const SPEAKER_LABEL = /\b(Speaker\s+[A-Za-z0-9]+)\s*:\s*/g;

/**
 * Split a basic-mode transcript blob into speaker turns.
 *
 * Text that appears before the first label (or when there are no labels at
 * all) is returned as a single turn with `speaker: null`, so callers can
 * always render the full transcript regardless of whether the model produced
 * labels. Empty turns are dropped.
 */
export function parseSpeakerTurns(text: string): SpeakerTurn[] {
  if (!text || !text.trim()) return [];

  // SPEAKER_LABEL is a shared global regex; matchAll seeds its clone from the
  // current lastIndex, so reset it in case hasSpeakerLabels left it advanced.
  SPEAKER_LABEL.lastIndex = 0;
  const matches = Array.from(text.matchAll(SPEAKER_LABEL));
  if (matches.length === 0) {
    return [{ speaker: null, text: text.trim() }];
  }

  const turns: SpeakerTurn[] = [];

  // Any text before the first label is an unattributed lead-in.
  const firstStart = matches[0].index ?? 0;
  const lead = text.slice(0, firstStart).trim();
  if (lead) turns.push({ speaker: null, text: lead });

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const label = m[1].replace(/\s+/g, ' ').trim();
    const contentStart = (m.index ?? 0) + m[0].length;
    const contentEnd = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
    const content = text.slice(contentStart, contentEnd).trim();
    turns.push({ speaker: label, text: content });
  }

  return turns.filter((t) => t.text.length > 0 || t.speaker !== null);
}

/**
 * Whether a transcript blob contains any inline speaker labels. Lets the UI
 * decide between the turn-by-turn layout and a plain paragraph.
 */
export function hasSpeakerLabels(text: string): boolean {
  SPEAKER_LABEL.lastIndex = 0;
  return SPEAKER_LABEL.test(text);
}

/**
 * Deterministic palette index (0-based) for a speaker label, so the same
 * speaker keeps the same accent color within a transcript. Returns 0 for
 * unattributed turns.
 */
export function speakerColorIndex(speaker: string | null, paletteSize: number): number {
  if (!speaker || paletteSize <= 0) return 0;
  const digits = speaker.match(/\d+/);
  if (digits) return Number.parseInt(digits[0], 10) % paletteSize;
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = (hash * 31 + speaker.charCodeAt(i)) % paletteSize;
  }
  return hash;
}

/** A single relabel-able turn across the whole basic-mode transcript. */
export interface BasicTurn {
  /** Stable 0-based position across all transcription rows, in order. */
  turnIndex: number;
  /** The original `Speaker N` label, or null for an unattributed lead-in. */
  speakerKey: string | null;
  /** The spoken text for this turn. */
  text: string;
}

/**
 * Flatten the basic-mode transcription rows into a single ordered list of
 * turns with a stable global `turnIndex`. Basic mode is normally one row, but
 * we iterate defensively over all rows (in array order) and concatenate their
 * parsed turns so the index space is contiguous and deterministic. The index
 * is what `SessionSpeakerTurn` overrides key off of, so it must stay stable as
 * long as the stored transcript text is unchanged.
 */
export function buildTurns(rows: ReadonlyArray<{ text: string }>): BasicTurn[] {
  const turns: BasicTurn[] = [];
  for (const row of rows) {
    for (const t of parseSpeakerTurns(row.text)) {
      turns.push({ turnIndex: turns.length, speakerKey: t.speaker, text: t.text });
    }
  }
  return turns;
}

/** A speaker-key default name keyed by the original `Speaker N` label. */
export type SpeakerDefaults = Record<string, string>;
/** A per-turn override name keyed by `turnIndex`. */
export type TurnOverrides = Record<number, string>;

/**
 * Resolve the display name for a turn using the two-layer precedence:
 *   per-turn override  >  per-speaker-key default  >  the raw speaker key.
 * Returns null only for unattributed lead-in turns with no override.
 */
export function resolveTurnName(
  turn: BasicTurn,
  defaults: SpeakerDefaults,
  overrides: TurnOverrides,
): string | null {
  const override = overrides[turn.turnIndex];
  if (override) return override;
  if (turn.speakerKey && defaults[turn.speakerKey]) return defaults[turn.speakerKey];
  return turn.speakerKey;
}

/**
 * Render the basic-mode transcript with resolved speaker names applied, one
 * turn per line (`Name: text`). Used to feed the summary prompt so the AI sees
 * the relabeled names instead of `Speaker N`. Unattributed turns render as bare
 * text. Returns an empty string when there are no turns.
 */
export function renderTurnsWithNames(
  turns: ReadonlyArray<BasicTurn>,
  defaults: SpeakerDefaults,
  overrides: TurnOverrides,
): string {
  return turns
    .map((turn) => {
      const name = resolveTurnName(turn, defaults, overrides);
      return name ? `${name}: ${turn.text}` : turn.text;
    })
    .join('\n');
}
