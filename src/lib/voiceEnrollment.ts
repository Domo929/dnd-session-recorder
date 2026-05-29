import type { VoiceEmbeddingBackend } from '@/services/voiceEmbedding';

/**
 * Pure validation + small mappings for the voice-enrollment flow. Kept free of
 * I/O so the API routes stay thin and the rules are unit-testable.
 *
 * Recording bounds mirror the design (docs/plans/2026-05-27-speaker-labels-design.md
 * §2): target 15s, 8s minimum, 60s maximum.
 */
export const MIN_VOICE_DURATION_MS = 8_000;
export const MAX_VOICE_DURATION_MS = 60_000;
export const MAX_VOICE_LABEL_LENGTH = 100;

export type ValidationResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/** Trim and bound-check a user-supplied voice-sample label. */
export function normalizeVoiceLabel(raw: string): ValidationResult<{ label: string }> {
  const label = (raw ?? '').trim();
  if (!label) {
    return { ok: false, error: 'Label is required.' };
  }
  if (label.length > MAX_VOICE_LABEL_LENGTH) {
    return { ok: false, error: `Label must be at most ${MAX_VOICE_LABEL_LENGTH} characters.` };
  }
  return { ok: true, label };
}

/** Ensure a clip's measured duration falls within the enrollment bounds. */
export function validateVoiceDurationMs(durationMs: number): ValidationResult<{ durationMs: number }> {
  if (!Number.isInteger(durationMs)) {
    return { ok: false, error: 'Duration must be an integer number of milliseconds.' };
  }
  if (durationMs < MIN_VOICE_DURATION_MS) {
    return {
      ok: false,
      error: `Clip is too short. Record at least ${MIN_VOICE_DURATION_MS / 1000}s.`,
    };
  }
  if (durationMs > MAX_VOICE_DURATION_MS) {
    return {
      ok: false,
      error: `Clip is too long. Keep it under ${MAX_VOICE_DURATION_MS / 1000}s.`,
    };
  }
  return { ok: true, durationMs };
}

/** Stable model identifier persisted alongside each embedding. */
export function embeddingModelFor(backend: VoiceEmbeddingBackend): string {
  return backend === 'onnx' ? 'ecapa-tdnn-v1' : 'mock-v1';
}
