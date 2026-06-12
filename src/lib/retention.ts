import { timingSafeEqual } from 'crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_AUDIO_RETENTION_DAYS = 28;
export const DEFAULT_SNIPPET_RETENTION_DAYS = 30;

export interface RetentionConfig {
  audioRetentionMs: number;
  snippetRetentionMs: number;
}

function parsePositiveDays(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the configured retention windows (days → ms). Falls back to the
 * design defaults (28d audio / 30d unknown-snippet) when unset or invalid.
 */
export function getRetentionConfig(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  return {
    audioRetentionMs: parsePositiveDays(env.AUDIO_RETENTION_DAYS, DEFAULT_AUDIO_RETENTION_DAYS) * DAY_MS,
    snippetRetentionMs:
      parsePositiveDays(env.UNKNOWN_SNIPPET_RETENTION_DAYS, DEFAULT_SNIPPET_RETENTION_DAYS) * DAY_MS,
  };
}

/** Constant-time string compare that won't throw on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Validate a cron request's `Authorization: Bearer <CRON_SECRET>` header.
 * Fails closed: if `CRON_SECRET` is unset, no request is ever authorized.
 */
export function isCronAuthorized(
  authHeader: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const secret = env.CRON_SECRET;
  if (!secret || !authHeader) return false;
  return safeEqual(authHeader, `Bearer ${secret}`);
}
