import { EMBEDDING_DIM } from '@/lib/voiceFingerprint';

export type VoiceEmbeddingBackend = 'mock' | 'onnx';

/**
 * Produces a fixed-dimension speaker embedding (voice fingerprint) from a clip
 * of recorded audio. Embeddings are L2-normalized so that cosine similarity
 * reduces to a dot product and lives in [-1, 1].
 */
export interface VoiceEmbeddingService {
  readonly backend: VoiceEmbeddingBackend;
  /** Embedding dimensionality. Always {@link EMBEDDING_DIM}. */
  readonly dimensions: number;
  /**
   * Embed an encoded audio clip (e.g. opus/webm/wav as produced by the
   * enrollment recorder). Returns an {@link EMBEDDING_DIM}-dim, L2-normalized
   * Float32Array suitable for {@link serializeEmbedding}.
   */
  embedClip(audio: Buffer): Promise<Float32Array>;
}

export const EMBEDDING_DIMENSIONS = EMBEDDING_DIM;

/**
 * L2-normalize a vector in place and return it. Zero (or non-finite) vectors
 * are returned unchanged so callers never produce NaNs.
 */
export function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm;
  return vec;
}
