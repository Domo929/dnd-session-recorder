import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_BYTES,
  EMBEDDING_DIM,
  cosineSimilarity,
  deserializeEmbedding,
  getFingerprintConfig,
  matchCluster,
  scoreVoice,
  selectExemplarsToEvict,
  serializeEmbedding,
  shouldLearn,
  type VoiceFingerprint,
} from '../voiceFingerprint';

/** Build a unit-ish embedding pointing mostly along axis `axis`, plus noise. */
function vec(axis: number, magnitude = 1, noise = 0): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  v[axis % EMBEDDING_DIM] = magnitude;
  if (noise) {
    for (let i = 0; i < EMBEDDING_DIM; i++) v[i] += noise * Math.sin(i * (axis + 1));
  }
  return v;
}

describe('embedding serialization', () => {
  it('round-trips a 192-dim float32 vector to 768 bytes and back', () => {
    const v = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = Math.sin(i) * 0.5;
    const buf = serializeEmbedding(v);
    expect(buf.length).toBe(EMBEDDING_BYTES);
    const back = deserializeEmbedding(buf);
    for (let i = 0; i < EMBEDDING_DIM; i++) expect(back[i]).toBeCloseTo(v[i], 6);
  });

  it('rejects wrong-length vectors and buffers', () => {
    expect(() => serializeEmbedding(new Float32Array(10))).toThrow();
    expect(() => deserializeEmbedding(Buffer.alloc(10))).toThrow();
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical direction, ~0 for orthogonal, -1 for opposite', () => {
    const a = vec(0);
    expect(cosineSimilarity(a, vec(0, 5))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, vec(1))).toBeCloseTo(0, 6);
    const opp = new Float32Array(EMBEDDING_DIM);
    opp[0] = -1;
    expect(cosineSimilarity(a, opp)).toBeCloseTo(-1, 6);
  });

  it('returns 0 for a zero vector instead of NaN', () => {
    expect(cosineSimilarity(vec(0), new Float32Array(EMBEDDING_DIM))).toBe(0);
  });

  it('returns 0 (not NaN/Infinity) on magnitude overflow', () => {
    const huge = new Float32Array(EMBEDDING_DIM);
    huge[0] = 1e200; // exceeds float32 range → stored as Infinity
    huge[1] = 1e200;
    expect(cosineSimilarity(huge, huge)).toBe(0);
  });

  it('returns 0 when an input contains NaN', () => {
    const bad = vec(0);
    bad[5] = NaN;
    expect(cosineSimilarity(bad, vec(0))).toBe(0);
  });

  it('throws on length mismatch', () => {
    expect(() => cosineSimilarity(new Float32Array(3), new Float32Array(4))).toThrow();
  });
});

describe('getFingerprintConfig', () => {
  it('uses documented defaults when env is empty', () => {
    expect(getFingerprintConfig({} as NodeJS.ProcessEnv)).toEqual({
      matchThreshold: 0.65,
      personFallbackThreshold: 0.55,
      learnThreshold: 0.8,
      maxExemplars: 10,
    });
  });

  it('reads overrides and ignores garbage', () => {
    const cfg = getFingerprintConfig({
      MATCH_THRESHOLD: '0.7',
      PERSON_FALLBACK_THRESHOLD: '0.5',
      LEARN_THRESHOLD: 'nope',
      MAX_EXEMPLARS_PER_VOICE: '5',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.matchThreshold).toBe(0.7);
    expect(cfg.personFallbackThreshold).toBe(0.5);
    expect(cfg.learnThreshold).toBe(0.8); // garbage falls back
    expect(cfg.maxExemplars).toBe(5);
  });

  it('clamps out-of-range thresholds into [-1, 1] to protect matching', () => {
    const cfg = getFingerprintConfig({
      MATCH_THRESHOLD: '1.5',
      PERSON_FALLBACK_THRESHOLD: '-0.5',
      LEARN_THRESHOLD: '9',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.matchThreshold).toBe(1);
    expect(cfg.personFallbackThreshold).toBe(-0.5); // valid cosine value, kept
    expect(cfg.learnThreshold).toBe(1);
  });
});

describe('scoreVoice', () => {
  it('returns the max cosine over seed + exemplars', () => {
    const fp: VoiceFingerprint = {
      voiceSampleId: 'v1',
      memberId: 'm1',
      label: 'Thorin',
      embeddings: [vec(0), vec(1), vec(2)],
    };
    // centroid aligns with the 2nd exemplar
    expect(scoreVoice(vec(1, 3), fp)).toBeCloseTo(1, 6);
  });
});

const cfg = getFingerprintConfig({} as NodeJS.ProcessEnv);

describe('matchCluster', () => {
  const thorin: VoiceFingerprint = {
    voiceSampleId: 'v-thorin',
    memberId: 'm-alice',
    label: 'Thorin',
    embeddings: [vec(0)],
  };
  const narrator: VoiceFingerprint = {
    voiceSampleId: 'v-narr',
    memberId: 'm-dm',
    label: 'Narrator',
    embeddings: [vec(50)],
  };

  it('returns unknown when there are no fingerprints', () => {
    const m = matchCluster(vec(0), [], cfg);
    expect(m.kind).toBe('unknown');
  });

  it('high-confidence match above the match threshold', () => {
    const m = matchCluster(vec(0, 2), [thorin, narrator], cfg);
    expect(m).toMatchObject({
      kind: 'matched',
      voiceSampleId: 'v-thorin',
      displayLabel: 'Thorin',
      matchConfidence: 'high',
    });
  });

  it('low-confidence person fallback in the [0.55, 0.65) band flags for review', () => {
    // Construct a centroid whose best cosine to Thorin lands ~0.6.
    const seed = vec(0);
    const other = vec(1);
    const centroid = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) centroid[i] = 0.6 * seed[i] + 0.8 * other[i];
    const score = cosineSimilarity(centroid, seed);
    expect(score).toBeGreaterThanOrEqual(0.55);
    expect(score).toBeLessThan(0.65);

    const m = matchCluster(centroid, [thorin, narrator], cfg);
    expect(m).toMatchObject({
      kind: 'matched',
      voiceSampleId: 'v-thorin',
      displayLabel: 'Thorin (?)',
      matchConfidence: 'low',
    });
  });

  it('unknown below the fallback threshold', () => {
    const m = matchCluster(vec(99), [thorin, narrator], cfg);
    expect(m.kind).toBe('unknown');
    expect(m.matchConfidence).toBe('none');
  });

  it('attributes to the closest voice of the best-matching person', () => {
    // Same member owns two voices; centroid is closest to the drunk variant.
    const sober: VoiceFingerprint = { voiceSampleId: 'v1', memberId: 'm', label: 'Thorin', embeddings: [vec(0)] };
    const drunk: VoiceFingerprint = { voiceSampleId: 'v2', memberId: 'm', label: 'Thorin (drunk)', embeddings: [vec(5)] };
    const m = matchCluster(vec(5, 2), [sober, drunk], cfg);
    expect(m).toMatchObject({ kind: 'matched', voiceSampleId: 'v2', matchConfidence: 'high' });
  });
});

describe('shouldLearn', () => {
  const highMatch = { kind: 'matched', matchConfidence: 'high', matchedScore: 0.85 } as const;
  const midMatch = { kind: 'matched', matchConfidence: 'high', matchedScore: 0.7 } as const;
  const lowMatch = { kind: 'matched', matchConfidence: 'low', matchedScore: 0.6 } as const;
  const unknown = { kind: 'unknown', matchConfidence: 'none', matchedScore: 0.4 } as const;

  it('learns from an auto-match at or above the learn threshold', () => {
    expect(shouldLearn({ ...highMatch, voiceSampleId: 'v', memberId: 'm', label: 'L', displayLabel: 'L' }, false, cfg)).toBe(true);
  });

  it('does NOT learn from a plain 0.65-0.80 auto-match', () => {
    expect(shouldLearn({ ...midMatch, voiceSampleId: 'v', memberId: 'm', label: 'L', displayLabel: 'L' }, false, cfg)).toBe(false);
  });

  it('does NOT auto-learn from a low-confidence fallback', () => {
    expect(shouldLearn({ ...lowMatch, voiceSampleId: 'v', memberId: 'm', label: 'L', displayLabel: 'L (?)' }, false, cfg)).toBe(false);
  });

  it('learns from any DM-confirmed match regardless of score', () => {
    expect(shouldLearn({ ...lowMatch, voiceSampleId: 'v', memberId: 'm', label: 'L', displayLabel: 'L (?)' }, true, cfg)).toBe(true);
  });

  it('never learns from an unknown cluster, even if DM "confirmed"', () => {
    expect(shouldLearn(unknown, true, cfg)).toBe(false);
  });
});

describe('selectExemplarsToEvict', () => {
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `e${i}`, createdAt: new Date(2026, 0, i + 1) }));

  it('evicts nothing within the cap', () => {
    expect(selectExemplarsToEvict(make(10), 10)).toEqual([]);
  });

  it('evicts the oldest when over the cap', () => {
    expect(selectExemplarsToEvict(make(11), 10)).toEqual(['e0']);
  });

  it('evicts multiple oldest when several over the cap', () => {
    expect(selectExemplarsToEvict(make(13), 10)).toEqual(['e0', 'e1', 'e2']);
  });

  it('does not depend on input ordering', () => {
    const shuffled = [...make(12)].reverse();
    expect(selectExemplarsToEvict(shuffled, 10).sort()).toEqual(['e0', 'e1']);
  });
});
