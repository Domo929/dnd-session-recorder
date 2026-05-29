'use client';

/**
 * Recording bounds for enrollment clips (design §2: 15s target, 8s min, 60s
 * max). Duplicated client-side so the recorder UI doesn't import the server-only
 * enrollment module; the API re-validates duration authoritatively.
 */
export const MIN_RECORDING_MS = 8_000;
export const MAX_RECORDING_MS = 60_000;

/**
 * Candidate recorder MIME types in priority order. Opus in a WebM container is
 * the broadly-supported, compact default for `MediaRecorder`; the rest are
 * fallbacks for browsers (notably Safari) that don't offer it.
 */
export const VOICE_RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

/**
 * Choose the first candidate the platform can record. Pure + injectable so the
 * selection logic is unit-testable without a real `MediaRecorder`. Returns
 * `undefined` when none match, letting the browser pick its own default.
 */
export function pickRecorderMimeType(
  candidates: readonly string[],
  isSupported: (mimeType: string) => boolean,
): string | undefined {
  return candidates.find(isSupported);
}
