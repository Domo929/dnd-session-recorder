import type { TranscriptionMode } from '@prisma/client';

/** All valid per-session transcription modes (mirrors the Prisma enum). */
export const TRANSCRIPTION_MODES: readonly TranscriptionMode[] = ['basic', 'speaker_labeled'];

export function isTranscriptionMode(value: unknown): value is TranscriptionMode {
  return typeof value === 'string' && (TRANSCRIPTION_MODES as readonly string[]).includes(value);
}

interface ResolveArgs {
  /** Raw client-requested mode (may be undefined/invalid). */
  requested: unknown;
  /** The campaign's configured default mode. */
  campaignDefault: TranscriptionMode;
  /** Number of voices enrolled across the campaign. */
  voiceSampleCount: number;
}

/**
 * Decide the effective transcription mode for a new session.
 *
 * Speaker-labeled transcription needs at least one enrolled voice to attribute
 * lines to, so we **fail closed**: if it's requested (or is the campaign
 * default) while the campaign has zero voice samples, we downgrade to `basic`
 * and report it so callers/UI can surface why.
 */
export function resolveTranscriptionMode({
  requested,
  campaignDefault,
  voiceSampleCount,
}: ResolveArgs): { mode: TranscriptionMode; downgraded: boolean } {
  const intended = isTranscriptionMode(requested) ? requested : campaignDefault;

  if (intended === 'speaker_labeled' && voiceSampleCount <= 0) {
    return { mode: 'basic', downgraded: true };
  }

  return { mode: intended, downgraded: false };
}
