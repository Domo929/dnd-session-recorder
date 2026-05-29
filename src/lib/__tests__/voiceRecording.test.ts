import { describe, it, expect } from 'vitest';
import { pickRecorderMimeType, VOICE_RECORDER_MIME_CANDIDATES } from '@/lib/voiceRecording';

describe('pickRecorderMimeType', () => {
  it('returns the first supported candidate in priority order', () => {
    const supported = new Set(['audio/ogg;codecs=opus', 'audio/webm']);
    expect(
      pickRecorderMimeType(VOICE_RECORDER_MIME_CANDIDATES, (t) => supported.has(t)),
    ).toBe('audio/webm');
  });

  it('prefers webm/opus when available', () => {
    const isSupported = (t: string) => t === 'audio/webm;codecs=opus' || t === 'audio/webm';
    expect(pickRecorderMimeType(VOICE_RECORDER_MIME_CANDIDATES, isSupported)).toBe('audio/webm;codecs=opus');
  });

  it('falls back to a later candidate when earlier ones are unsupported', () => {
    const isSupported = (t: string) => t === 'audio/mp4';
    expect(pickRecorderMimeType(['audio/webm;codecs=opus', 'audio/mp4'], isSupported)).toBe('audio/mp4');
  });

  it('returns undefined when nothing is supported (let the browser choose)', () => {
    expect(pickRecorderMimeType(VOICE_RECORDER_MIME_CANDIDATES, () => false)).toBeUndefined();
  });
});
