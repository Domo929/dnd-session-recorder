import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { EMBEDDING_BYTES } from '@/lib/voiceFingerprint';

/**
 * Verify the diarization container's callback signature: HMAC-SHA256 of the raw
 * request body keyed by the per-job secret (hex). Timing-safe, and tolerant of
 * a `sha256=` prefix. Never throws on malformed input — returns false.
 */
export function verifyCallbackSignature(
  secretHex: string,
  rawBody: string,
  signatureHeader: string | undefined | null,
): boolean {
  if (!signatureHeader) return false;
  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  if (!/^[0-9a-fA-F]+$/.test(provided) || provided.length % 2 !== 0) return false;

  let expected: string;
  try {
    expected = createHmac('sha256', Buffer.from(secretHex, 'hex')).update(rawBody).digest('hex');
  } catch {
    return false;
  }

  const a = Buffer.from(provided.toLowerCase(), 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface DiarizationCluster {
  clusterIdx: number;
  embeddingCentroid: Buffer;
  segmentCount: number;
  totalDurationMs: number;
  representativeStartMs?: number;
  representativeEndMs?: number;
}

export interface DiarizationSegment {
  startMs: number;
  endMs: number;
  text: string;
  clusterIdx: number;
  confidence?: number;
}

export interface DiarizationPayload {
  clusters: DiarizationCluster[];
  segments: DiarizationSegment[];
}

const base64Embedding = z
  .string()
  .transform((s, ctx) => {
    const buf = Buffer.from(s, 'base64');
    if (buf.length !== EMBEDDING_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `embedding must decode to ${EMBEDDING_BYTES} bytes, got ${buf.length}`,
      });
      return z.NEVER;
    }
    return buf;
  });

const clusterSchema = z.object({
  clusterIdx: z.number().int().nonnegative(),
  embeddingCentroid: base64Embedding,
  segmentCount: z.number().int().nonnegative(),
  totalDurationMs: z.number().int().nonnegative(),
  representativeStartMs: z.number().int().nonnegative().optional(),
  representativeEndMs: z.number().int().nonnegative().optional(),
});

const segmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
  clusterIdx: z.number().int().nonnegative(),
  confidence: z.number().optional(),
});

const payloadSchema = z
  .object({
    clusters: z.array(clusterSchema).min(1),
    segments: z.array(segmentSchema).min(1),
  })
  .superRefine((data, ctx) => {
    const indices = data.clusters.map((c) => c.clusterIdx);
    if (new Set(indices).size !== indices.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate cluster indices' });
    }
    const known = new Set(indices);
    for (const seg of data.segments) {
      if (!known.has(seg.clusterIdx)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `segment references unknown clusterIdx ${seg.clusterIdx}`,
        });
      }
    }
  });

export type ParseResult =
  | { ok: true; payload: DiarizationPayload }
  | { ok: false; error: string };

/** Validate and normalize the container's callback JSON. */
export function parseDiarizationPayload(input: unknown): ParseResult {
  const result = payloadSchema.safeParse(input);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, payload: result.data };
}
