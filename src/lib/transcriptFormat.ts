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
