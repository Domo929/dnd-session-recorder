/**
 * Pure helpers for the self-refining voice-fingerprint matching layer
 * (design: docs/plans/2026-05-29-self-refining-fingerprints-design.md).
 *
 * A voice's fingerprint = its seed embedding (`VoiceSample.embedding`, from
 * enrollment or a tagged cluster) plus a capped set of session-learned
 * `VoiceExemplar` embeddings. Everything here is deterministic and side-effect
 * free so it can be unit-tested with synthetic vectors and reused by the
 * diarization callback (SL-4). No ONNX/model dependency.
 */

/** ECAPA-TDNN embedding dimensionality. */
export const EMBEDDING_DIM = 192;
/** Serialized size: 192 * 4-byte little-endian float32. */
export const EMBEDDING_BYTES = EMBEDDING_DIM * 4;

export interface FingerprintConfig {
  /** Per-voice confident-match cosine threshold. */
  matchThreshold: number;
  /** Lower band: plausibly this person, but flag low-confidence for review. */
  personFallbackThreshold: number;
  /** Minimum auto-match score to fold a cluster into a fingerprint. */
  learnThreshold: number;
  /** Per-voice learned-exemplar cap (seed excluded). */
  maxExemplars: number;
}

const DEFAULTS: FingerprintConfig = {
  matchThreshold: 0.65,
  personFallbackThreshold: 0.55,
  learnThreshold: 0.8,
  maxExemplars: 10,
};

function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Resolve tunable thresholds from the environment, falling back to defaults. */
export function getFingerprintConfig(env: NodeJS.ProcessEnv = process.env): FingerprintConfig {
  return {
    matchThreshold: parseNumber(env.MATCH_THRESHOLD, DEFAULTS.matchThreshold),
    personFallbackThreshold: parseNumber(
      env.PERSON_FALLBACK_THRESHOLD,
      DEFAULTS.personFallbackThreshold,
    ),
    learnThreshold: parseNumber(env.LEARN_THRESHOLD, DEFAULTS.learnThreshold),
    maxExemplars: Math.max(0, Math.trunc(parseNumber(env.MAX_EXEMPLARS_PER_VOICE, DEFAULTS.maxExemplars))),
  };
}

/** Serialize a 192-dim embedding to a little-endian float32 Buffer (768 bytes). */
export function serializeEmbedding(vec: Float32Array): Buffer {
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`embedding must be ${EMBEDDING_DIM}-dim, got ${vec.length}`);
  }
  const buf = Buffer.allocUnsafe(EMBEDDING_BYTES);
  for (let i = 0; i < EMBEDDING_DIM; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

/** Deserialize a 768-byte little-endian float32 Buffer to a 192-dim embedding. */
export function deserializeEmbedding(buf: Buffer): Float32Array {
  if (buf.length !== EMBEDDING_BYTES) {
    throw new Error(`embedding buffer must be ${EMBEDDING_BYTES} bytes, got ${buf.length}`);
  }
  const vec = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] = buf.readFloatLE(i * 4);
  return vec;
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 if either vector is zero-length
 * (degenerate) so it can never spuriously match.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** A voice and the embeddings that make up its fingerprint (seed + exemplars). */
export interface VoiceFingerprint {
  voiceSampleId: string;
  memberId: string;
  label: string;
  /** Seed embedding first, then learned exemplars. Must be non-empty. */
  embeddings: Float32Array[];
}

export type MatchConfidence = 'high' | 'low' | 'none';

export type ClusterMatch =
  | {
      kind: 'matched';
      voiceSampleId: string;
      memberId: string;
      label: string;
      displayLabel: string;
      matchConfidence: 'high' | 'low';
      matchedScore: number;
    }
  | { kind: 'unknown'; matchConfidence: 'none'; matchedScore: number | null };

/** Score a cluster centroid against one voice: max cosine over seed+exemplars. */
export function scoreVoice(centroid: Float32Array, fp: VoiceFingerprint): number {
  let best = -Infinity;
  for (const e of fp.embeddings) {
    const s = cosineSimilarity(centroid, e);
    if (s > best) best = s;
  }
  return best === -Infinity ? 0 : best;
}

/**
 * Resolve a diarized cluster centroid to a voice.
 *
 *  - best voice ≥ matchThreshold        → high-confidence match (label)
 *  - personFallbackThreshold ≤ best     → low-confidence: attribute to the
 *    closest voice of the best-matching person, flagged "{label} (?)" for review
 *  - otherwise                          → unknown (lazy-tag later)
 *
 * Person aggregation is max over a member's voices; the closest voice of the
 * best person is therefore the overall best voice, but the grouping is kept
 * explicit so the aggregation can change without touching callers.
 */
export function matchCluster(
  centroid: Float32Array,
  fingerprints: VoiceFingerprint[],
  config: FingerprintConfig = getFingerprintConfig(),
): ClusterMatch {
  if (fingerprints.length === 0) {
    return { kind: 'unknown', matchConfidence: 'none', matchedScore: null };
  }

  const scored = fingerprints.map((fp) => ({ fp, score: scoreVoice(centroid, fp) }));

  // Best voice per member, then the best member.
  const bestByMember = new Map<string, { fp: VoiceFingerprint; score: number }>();
  for (const s of scored) {
    const cur = bestByMember.get(s.fp.memberId);
    if (!cur || s.score > cur.score) bestByMember.set(s.fp.memberId, s);
  }
  let best: { fp: VoiceFingerprint; score: number } | null = null;
  for (const s of bestByMember.values()) {
    if (!best || s.score > best.score) best = s;
  }
  if (!best) return { kind: 'unknown', matchConfidence: 'none', matchedScore: null };

  if (best.score >= config.matchThreshold) {
    return {
      kind: 'matched',
      voiceSampleId: best.fp.voiceSampleId,
      memberId: best.fp.memberId,
      label: best.fp.label,
      displayLabel: best.fp.label,
      matchConfidence: 'high',
      matchedScore: best.score,
    };
  }
  if (best.score >= config.personFallbackThreshold) {
    return {
      kind: 'matched',
      voiceSampleId: best.fp.voiceSampleId,
      memberId: best.fp.memberId,
      label: best.fp.label,
      displayLabel: `${best.fp.label} (?)`,
      matchConfidence: 'low',
      matchedScore: best.score,
    };
  }
  return { kind: 'unknown', matchConfidence: 'none', matchedScore: best.score };
}

/**
 * Learn-gate: only high-confidence audio refines a fingerprint. Add an exemplar
 * iff the DM explicitly confirmed the match, OR it was a high-confidence
 * auto-match scoring ≥ learnThreshold. Low-confidence/unknown never learn.
 */
export function shouldLearn(
  match: ClusterMatch,
  dmConfirmed: boolean,
  config: FingerprintConfig = getFingerprintConfig(),
): boolean {
  if (dmConfirmed) return match.kind === 'matched';
  return (
    match.kind === 'matched' &&
    match.matchConfidence === 'high' &&
    match.matchedScore >= config.learnThreshold
  );
}

/** A stored learned exemplar, ordered for eviction by creation time. */
export interface StoredExemplar {
  id: string;
  createdAt: Date;
}

/**
 * After adding an exemplar, return the ids of the oldest learned exemplars that
 * must be evicted to respect the per-voice cap (the seed is not an exemplar and
 * is never a candidate). Returns [] when within the cap.
 */
export function selectExemplarsToEvict(
  exemplars: StoredExemplar[],
  maxExemplars: number,
): string[] {
  if (exemplars.length <= maxExemplars) return [];
  const oldestFirst = [...exemplars].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return oldestFirst.slice(0, exemplars.length - maxExemplars).map((e) => e.id);
}
