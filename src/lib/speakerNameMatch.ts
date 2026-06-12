/**
 * Fuzzy speaker-name matching for basic-mode relabeling (Track A).
 *
 * Goal: keep speaker names consistent across a campaign. When the user types a
 * name that already exists in the campaign registry — exactly, in different
 * casing, or with a small typo — we snap to the canonical existing spelling
 * instead of forking a duplicate (e.g. avoid both `bruce` and `Bruce`).
 *
 * Pure functions only — no DB, React, or external deps.
 */

/**
 * Default similarity threshold (Dice coefficient) for a "near" match. Fuzzy
 * matches are surfaced as suggestions for the user to confirm — not applied
 * silently — so a moderate bar catches common typos (e.g. a doubled or dropped
 * letter) while avoiding obviously-different names.
 */
export const DEFAULT_MATCH_THRESHOLD = 0.7;

/**
 * Normalize a name for comparison: trim, lowercase, collapse internal
 * whitespace, and strip surrounding punctuation. Two names with the same
 * normalized form are considered the same name.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s'"`.,;:!?()-]+|[\s'"`.,;:!?()-]+$/g, '');
}

/** Bigram set of a normalized string (spaces removed). */
function bigrams(normalized: string): Map<string, number> {
  const s = normalized.replace(/\s+/g, '');
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    out.set(bg, (out.get(bg) ?? 0) + 1);
  }
  return out;
}

/**
 * Sørensen–Dice coefficient over character bigrams of the two names'
 * normalized forms. Returns 1 for identical normalized strings (including
 * single-character names, where bigrams are empty) and 0 for no overlap.
 */
export function diceCoefficient(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;

  const aGrams = bigrams(na);
  const bGrams = bigrams(nb);
  const aTotal = [...aGrams.values()].reduce((s, n) => s + n, 0);
  const bTotal = [...bGrams.values()].reduce((s, n) => s + n, 0);
  if (aTotal === 0 || bTotal === 0) return 0; // one side is a single char, not equal

  let intersection = 0;
  for (const [bg, count] of aGrams) {
    const other = bGrams.get(bg);
    if (other) intersection += Math.min(count, other);
  }
  return (2 * intersection) / (aTotal + bTotal);
}

export interface NameMatch {
  /** The canonical existing name (original casing) that best matches. */
  name: string;
  /** Similarity score in [0, 1]; 1 means an exact normalized match. */
  score: number;
  /** True when the normalized forms are identical (casing/spacing only). */
  exact: boolean;
}

/**
 * Find the best matching registry name for `input`. Prefers an exact
 * normalized match; otherwise returns the highest Dice-scoring candidate at or
 * above `threshold`. Returns null when nothing qualifies (i.e. it's a genuinely
 * new name). Ties are broken by registry order (first wins), so callers should
 * pass the registry in a stable, preferred order.
 */
export function findBestNameMatch(
  input: string,
  registry: readonly string[],
  threshold: number = DEFAULT_MATCH_THRESHOLD,
): NameMatch | null {
  const normInput = normalizeName(input);
  if (!normInput) return null;

  let best: NameMatch | null = null;
  for (const candidate of registry) {
    const normCandidate = normalizeName(candidate);
    if (!normCandidate) continue;

    if (normCandidate === normInput) {
      return { name: candidate, score: 1, exact: true };
    }

    const score = diceCoefficient(normInput, normCandidate);
    if (score >= threshold && (!best || score > best.score)) {
      best = { name: candidate, score, exact: false };
    }
  }
  return best;
}

/**
 * Resolve a user-typed name to its canonical campaign spelling: if it matches
 * an existing registry entry (exact-normalized or fuzzy), return that entry's
 * original casing; otherwise return the input trimmed (a new name). This is the
 * single funnel that keeps casing consistent on write.
 */
export function canonicalizeName(
  input: string,
  registry: readonly string[],
  threshold: number = DEFAULT_MATCH_THRESHOLD,
): string {
  const match = findBestNameMatch(input, registry, threshold);
  return match ? match.name : input.trim();
}
