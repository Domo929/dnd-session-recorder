import { describe, it, expect } from 'vitest';
import {
  MIN_VOICE_DURATION_MS,
  MAX_VOICE_DURATION_MS,
  MAX_VOICE_LABEL_LENGTH,
  normalizeVoiceLabel,
  validateVoiceDurationMs,
  embeddingModelFor,
} from '@/lib/voiceEnrollment';

describe('normalizeVoiceLabel', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeVoiceLabel('  Thorin  ')).toEqual({ ok: true, label: 'Thorin' });
  });

  it('rejects an empty or whitespace-only label', () => {
    expect(normalizeVoiceLabel('   ').ok).toBe(false);
    expect(normalizeVoiceLabel('').ok).toBe(false);
  });

  it('rejects a label longer than the limit', () => {
    const tooLong = 'x'.repeat(MAX_VOICE_LABEL_LENGTH + 1);
    expect(normalizeVoiceLabel(tooLong).ok).toBe(false);
  });

  it('accepts a label exactly at the limit', () => {
    const atLimit = 'x'.repeat(MAX_VOICE_LABEL_LENGTH);
    expect(normalizeVoiceLabel(atLimit)).toEqual({ ok: true, label: atLimit });
  });
});

describe('validateVoiceDurationMs', () => {
  it('accepts a duration within bounds', () => {
    expect(validateVoiceDurationMs(15_000).ok).toBe(true);
  });

  it('accepts the exact min and max bounds', () => {
    expect(validateVoiceDurationMs(MIN_VOICE_DURATION_MS).ok).toBe(true);
    expect(validateVoiceDurationMs(MAX_VOICE_DURATION_MS).ok).toBe(true);
  });

  it('rejects a clip that is too short', () => {
    expect(validateVoiceDurationMs(MIN_VOICE_DURATION_MS - 1).ok).toBe(false);
  });

  it('rejects a clip that is too long', () => {
    expect(validateVoiceDurationMs(MAX_VOICE_DURATION_MS + 1).ok).toBe(false);
  });

  it('rejects non-finite or non-integer values', () => {
    expect(validateVoiceDurationMs(NaN).ok).toBe(false);
    expect(validateVoiceDurationMs(15_000.5).ok).toBe(false);
    expect(validateVoiceDurationMs(Infinity).ok).toBe(false);
  });
});

describe('embeddingModelFor', () => {
  it('maps the onnx backend to the real model id', () => {
    expect(embeddingModelFor('onnx')).toBe('ecapa-tdnn-v1');
  });

  it('maps the mock backend to a mock model id', () => {
    expect(embeddingModelFor('mock')).toBe('mock-v1');
  });
});
