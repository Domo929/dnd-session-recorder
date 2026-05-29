import { describe, it, expect, afterEach } from 'vitest';
import {
  createVoiceEmbeddingService,
  getVoiceEmbeddingService,
  resetVoiceEmbeddingService,
  EMBEDDING_DIMENSIONS,
  l2Normalize,
} from '@/services/voiceEmbedding';
import { MockVoiceEmbeddingService } from '@/services/voiceEmbedding/mock';
import { OnnxVoiceEmbeddingService } from '@/services/voiceEmbedding/onnx';
import {
  serializeEmbedding,
  deserializeEmbedding,
  cosineSimilarity,
} from '@/lib/voiceFingerprint';

const clipA = Buffer.from('the quick brown fox said hello adventurer');
const clipB = Buffer.from('a wholly different utterance from another speaker');

afterEach(() => resetVoiceEmbeddingService());

describe('l2Normalize', () => {
  it('produces a unit vector', () => {
    const v = l2Normalize(Float32Array.from([3, 4]));
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6);
  });

  it('leaves a zero vector unchanged (no NaN)', () => {
    const v = l2Normalize(new Float32Array([0, 0, 0]));
    expect([...v]).toEqual([0, 0, 0]);
  });
});

describe('MockVoiceEmbeddingService', () => {
  const svc = new MockVoiceEmbeddingService();

  it('reports the mock backend and correct dimensionality', async () => {
    expect(svc.backend).toBe('mock');
    expect(svc.dimensions).toBe(EMBEDDING_DIMENSIONS);
    const v = await svc.embedClip(clipA);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(EMBEDDING_DIMENSIONS);
  });

  it('is deterministic for identical input', async () => {
    const a1 = await svc.embedClip(clipA);
    const a2 = await svc.embedClip(clipA);
    expect([...a1]).toEqual([...a2]);
  });

  it('produces distinct vectors for distinct input', async () => {
    const a = await svc.embedClip(clipA);
    const b = await svc.embedClip(clipB);
    expect(cosineSimilarity(a, b)).toBeLessThan(0.99);
  });

  it('returns an L2-normalized vector', async () => {
    const v = await svc.embedClip(clipA);
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    expect(Math.sqrt(sumSq)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('round-trips through serializeEmbedding/deserializeEmbedding', async () => {
    const v = await svc.embedClip(clipA);
    const restored = deserializeEmbedding(serializeEmbedding(v));
    expect(cosineSimilarity(v, restored)).toBeCloseTo(1, 5);
  });
});

describe('createVoiceEmbeddingService', () => {
  it('defaults to the mock backend when nothing is configured', () => {
    expect(createVoiceEmbeddingService({} as NodeJS.ProcessEnv).backend).toBe('mock');
  });

  it('uses the mock backend when MOCK_AI_SERVICES=true even with a model path', () => {
    const svc = createVoiceEmbeddingService({
      MOCK_AI_SERVICES: 'true',
      VOICE_EMBEDDING_MODEL_PATH: '/models/ecapa.onnx',
    } as unknown as NodeJS.ProcessEnv);
    expect(svc).toBeInstanceOf(MockVoiceEmbeddingService);
  });

  it('selects the ONNX backend when a model path is set and mocking is off', () => {
    const svc = createVoiceEmbeddingService({
      VOICE_EMBEDDING_MODEL_PATH: '/models/ecapa.onnx',
    } as unknown as NodeJS.ProcessEnv);
    expect(svc).toBeInstanceOf(OnnxVoiceEmbeddingService);
    expect(svc.backend).toBe('onnx');
  });
});

describe('getVoiceEmbeddingService', () => {
  it('caches a singleton until reset', () => {
    const first = getVoiceEmbeddingService();
    expect(getVoiceEmbeddingService()).toBe(first);
    resetVoiceEmbeddingService();
    expect(getVoiceEmbeddingService()).not.toBe(first);
  });
});
