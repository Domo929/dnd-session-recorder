// Campaign transcription vocabulary ("NPC / term dictionary").
//
// Users type campaign-specific proper nouns and jargon (NPC names, place
// names, invented spells, etc.) into a free-form field so the transcription
// model spells them correctly — e.g. "Jabarquious" instead of "Jabarkius".
//
// Storage is a single free-form Text column on Campaign. Users may separate
// terms with newlines and/or commas; we normalize to a clean, de-duplicated,
// order-preserving list before threading it into the provider prompt.

// Cap how many terms we forward to the model. A runaway list would bloat every
// request and dilute the bias; this keeps the hint focused and cheap.
export const MAX_VOCABULARY_TERMS = 200;

// Defensive per-term length cap (characters). Anything longer is almost
// certainly not a single proper noun and would just be noise.
export const MAX_TERM_LENGTH = 80;

/**
 * Parse the raw free-form vocabulary text into a normalized term list.
 *
 * - Splits on newlines and commas.
 * - Trims surrounding whitespace.
 * - Drops empty entries and entries longer than {@link MAX_TERM_LENGTH}.
 * - De-duplicates case-insensitively while preserving first-seen casing/order.
 * - Caps the result at {@link MAX_VOCABULARY_TERMS}.
 */
export function parseVocabularyTerms(raw: string | null | undefined): string[] {
  if (!raw) return [];

  const seen = new Set<string>();
  const terms: string[] = [];

  for (const piece of raw.split(/[\n,]+/)) {
    const term = piece.trim();
    if (!term || term.length > MAX_TERM_LENGTH) continue;

    const key = term.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_VOCABULARY_TERMS) break;
  }

  return terms;
}

/**
 * Build the sentence appended to a transcription prompt that biases spelling
 * toward the campaign vocabulary. Returns an empty string when there are no
 * usable terms, so callers can safely concatenate unconditionally.
 */
export function buildVocabularyPromptSection(
  raw: string | null | undefined,
): string {
  const terms = parseVocabularyTerms(raw);
  if (terms.length === 0) return '';

  return (
    ' The following are proper nouns and special terms used in this campaign — ' +
    'when you hear these, prefer these exact spellings: ' +
    terms.join(', ') +
    '.'
  );
}

/**
 * Build the short, comma-separated phrase hint used by transcription providers
 * that accept a free-text `prompt`/biasing parameter (e.g. OpenAI Whisper,
 * whisper.cpp initial prompt). Returns an empty string when there are no terms.
 */
export function buildVocabularyPhraseHint(
  raw: string | null | undefined,
): string {
  return parseVocabularyTerms(raw).join(', ');
}
