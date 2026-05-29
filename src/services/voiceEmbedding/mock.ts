import { createHash } from 'crypto';
import {
  EMBEDDING_DIMENSIONS,
  l2Normalize,
  type VoiceEmbeddingService,
} from './types';

/**
 * Deterministic, dependency-free embedding used in development, tests, and
 * whenever no real model is configured (MOCK_AI_SERVICES=true or
 * VOICE_EMBEDDING_MODEL_PATH unset).
 *
 * The same audio bytes always map to the same unit vector, and distinct clips
 * map to distinct vectors, so the matching/learning logic in voiceFingerprint
 * can be exercised end-to-end without a heavyweight ONNX runtime.
 */
export class MockVoiceEmbeddingService implements VoiceEmbeddingService {
  readonly backend = 'mock' as const;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embedClip(audio: Buffer): Promise<Float32Array> {
    // Expand a SHA-256 digest of the clip into EMBEDDING_DIM floats by hashing
    // (digest || counter), giving a deterministic but well-spread vector.
    const vec = new Float32Array(this.dimensions);
    const base = createHash('sha256').update(audio).digest();
    let produced = 0;
    let counter = 0;
    while (produced < this.dimensions) {
      const block = createHash('sha256')
        .update(base)
        .update(Buffer.from([counter & 0xff, (counter >> 8) & 0xff]))
        .digest();
      for (let i = 0; i + 4 <= block.length && produced < this.dimensions; i += 4) {
        // Map a uint32 to roughly [-1, 1).
        const u = block.readUInt32LE(i);
        vec[produced++] = u / 0x80000000 - 1;
      }
      counter++;
    }
    return l2Normalize(vec);
  }
}
