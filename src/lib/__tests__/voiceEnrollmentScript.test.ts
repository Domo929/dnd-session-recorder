import { describe, it, expect } from 'vitest';
import {
  VOICE_ENROLLMENT_SCRIPT,
  VOICE_ENROLLMENT_SCRIPT_TITLE,
} from '@/lib/voiceEnrollmentScript';

describe('voice enrollment script', () => {
  it('has a non-empty title', () => {
    expect(VOICE_ENROLLMENT_SCRIPT_TITLE.trim().length).toBeGreaterThan(0);
  });

  it('is a non-empty passage of a sensible read-aloud length', () => {
    const length = VOICE_ENROLLMENT_SCRIPT.trim().length;
    // Long enough to comfortably exceed the 8s enrollment minimum, short enough
    // to read within the 60s cap (see voiceRecording.ts).
    expect(length).toBeGreaterThan(120);
    expect(length).toBeLessThan(800);
  });

  it('exercises a range of phonetic content (varied letters and a number)', () => {
    const lower = VOICE_ENROLLMENT_SCRIPT.toLowerCase();
    const distinctLetters = new Set(lower.replace(/[^a-z]/g, '').split(''));
    // A phonetically rich passage should use most of the alphabet.
    expect(distinctLetters.size).toBeGreaterThanOrEqual(20);
    // Includes a spoken number for digit/round-vowel coverage.
    expect(lower).toContain('five');
  });
});
