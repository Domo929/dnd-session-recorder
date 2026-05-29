import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  verifyCallbackSignature,
  parseDiarizationPayload,
} from '@/lib/diarizationCallback';

const SECRET = 'a'.repeat(64);

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(body).digest('hex');
}

describe('verifyCallbackSignature', () => {
  it('accepts a correct HMAC-SHA256 signature', () => {
    const body = JSON.stringify({ hello: 'world' });
    expect(verifyCallbackSignature(SECRET, body, sign(body))).toBe(true);
  });

  it('accepts a sha256= prefixed signature', () => {
    const body = '{"a":1}';
    expect(verifyCallbackSignature(SECRET, body, `sha256=${sign(body)}`)).toBe(true);
  });

  it('rejects a wrong signature', () => {
    const body = '{"a":1}';
    expect(verifyCallbackSignature(SECRET, body, sign('{"a":2}'))).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const body = '{"a":1}';
    expect(verifyCallbackSignature(SECRET, body, sign(body, 'b'.repeat(64)))).toBe(false);
  });

  it('rejects missing/malformed signatures without throwing', () => {
    const body = '{"a":1}';
    expect(verifyCallbackSignature(SECRET, body, '')).toBe(false);
    expect(verifyCallbackSignature(SECRET, body, 'not-hex-!!')).toBe(false);
    expect(verifyCallbackSignature(SECRET, body, undefined)).toBe(false);
  });
});

function validPayload() {
  const embedding = Buffer.alloc(768).toString('base64');
  return {
    clusters: [
      {
        clusterIdx: 0,
        embeddingCentroid: embedding,
        segmentCount: 3,
        totalDurationMs: 12000,
        representativeStartMs: 1000,
        representativeEndMs: 11000,
      },
    ],
    segments: [
      { startMs: 0, endMs: 5000, text: 'Hello there.', clusterIdx: 0 },
      { startMs: 5000, endMs: 9000, text: 'General Kenobi.', clusterIdx: 0, confidence: 0.9 },
    ],
  };
}

describe('parseDiarizationPayload', () => {
  it('accepts a well-formed payload', () => {
    const result = parseDiarizationPayload(validPayload());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.clusters).toHaveLength(1);
      expect(result.payload.segments).toHaveLength(2);
      expect(result.payload.clusters[0].embeddingCentroid).toBeInstanceOf(Buffer);
      expect(result.payload.clusters[0].embeddingCentroid.length).toBe(768);
    }
  });

  it('rejects an embedding that is not 768 bytes', () => {
    const p = validPayload();
    p.clusters[0].embeddingCentroid = Buffer.alloc(700).toString('base64');
    const result = parseDiarizationPayload(p);
    expect(result.ok).toBe(false);
  });

  it('rejects a segment referencing an unknown clusterIdx', () => {
    const p = validPayload();
    p.segments[0].clusterIdx = 9;
    const result = parseDiarizationPayload(p);
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate cluster indices', () => {
    const p = validPayload();
    p.clusters.push({ ...p.clusters[0] });
    const result = parseDiarizationPayload(p);
    expect(result.ok).toBe(false);
  });

  it('rejects non-object / empty input', () => {
    expect(parseDiarizationPayload(null).ok).toBe(false);
    expect(parseDiarizationPayload({}).ok).toBe(false);
    expect(parseDiarizationPayload({ clusters: [], segments: [] }).ok).toBe(false);
  });
});
