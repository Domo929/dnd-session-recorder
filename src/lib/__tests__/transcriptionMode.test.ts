import { describe, it, expect } from 'vitest';
import {
  TRANSCRIPTION_MODES,
  isTranscriptionMode,
  resolveTranscriptionMode,
} from '@/lib/transcriptionMode';

describe('isTranscriptionMode', () => {
  it('accepts the known modes', () => {
    for (const mode of TRANSCRIPTION_MODES) {
      expect(isTranscriptionMode(mode)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isTranscriptionMode('fancy')).toBe(false);
    expect(isTranscriptionMode('')).toBe(false);
    expect(isTranscriptionMode(undefined)).toBe(false);
    expect(isTranscriptionMode(null)).toBe(false);
    expect(isTranscriptionMode(2)).toBe(false);
  });
});

describe('resolveTranscriptionMode', () => {
  it('uses the requested mode when valid and enrollable', () => {
    expect(
      resolveTranscriptionMode({
        requested: 'speaker_labeled',
        campaignDefault: 'basic',
        voiceSampleCount: 3,
      }),
    ).toEqual({ mode: 'speaker_labeled', downgraded: false });
  });

  it('falls back to the campaign default when nothing valid is requested', () => {
    expect(
      resolveTranscriptionMode({
        requested: undefined,
        campaignDefault: 'speaker_labeled',
        voiceSampleCount: 1,
      }),
    ).toEqual({ mode: 'speaker_labeled', downgraded: false });

    expect(
      resolveTranscriptionMode({
        requested: 'bogus',
        campaignDefault: 'basic',
        voiceSampleCount: 1,
      }),
    ).toEqual({ mode: 'basic', downgraded: false });
  });

  it('fails closed to basic when speaker_labeled is asked for with zero enrolled voices', () => {
    expect(
      resolveTranscriptionMode({
        requested: 'speaker_labeled',
        campaignDefault: 'basic',
        voiceSampleCount: 0,
      }),
    ).toEqual({ mode: 'basic', downgraded: true });
  });

  it('downgrades a speaker_labeled campaign default when no voices are enrolled', () => {
    expect(
      resolveTranscriptionMode({
        requested: undefined,
        campaignDefault: 'speaker_labeled',
        voiceSampleCount: 0,
      }),
    ).toEqual({ mode: 'basic', downgraded: true });
  });

  it('does not flag a downgrade when basic was already intended', () => {
    expect(
      resolveTranscriptionMode({
        requested: 'basic',
        campaignDefault: 'speaker_labeled',
        voiceSampleCount: 0,
      }),
    ).toEqual({ mode: 'basic', downgraded: false });
  });
});
