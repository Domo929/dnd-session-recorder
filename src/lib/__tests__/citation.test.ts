import { describe, it, expect } from 'vitest';
import { formatTimestamp, formatCitation } from '@/lib/citation';

describe('formatTimestamp', () => {
  it('formats seconds as H:MM:SS', () => {
    expect(formatTimestamp(3735)).toBe('1:02:15');
    expect(formatTimestamp(75)).toBe('0:01:15');
  });
  it('clamps negatives to zero', () => {
    expect(formatTimestamp(-5)).toBe('0:00:00');
  });
});

describe('formatCitation', () => {
  const base = { sessionTitle: 'The Crypt', startTime: 3735 };
  it('single speaker', () => {
    expect(formatCitation({ ...base, sourceType: 'transcript', speakerLabels: ['Thalia'] }))
      .toBe('[Session "The Crypt" @ 1:02:15, Thalia]');
  });
  it('multiple speakers', () => {
    expect(formatCitation({ ...base, sourceType: 'transcript', speakerLabels: ['Thalia', 'Bren'] }))
      .toBe('[Session "The Crypt" @ 1:02:15, speakers: Thalia, Bren]');
  });
  it('transcript with no speakers omits the speaker clause', () => {
    expect(formatCitation({ ...base, sourceType: 'transcript', speakerLabels: [] }))
      .toBe('[Session "The Crypt" @ 1:02:15]');
  });
  it('transcript with null startTime omits the timestamp', () => {
    expect(formatCitation({ sessionTitle: 'The Crypt', sourceType: 'transcript', speakerLabels: ['Thalia'], startTime: null }))
      .toBe('[Session "The Crypt", Thalia]');
  });
  it('summary chunk', () => {
    expect(formatCitation({ sessionTitle: 'The Crypt', sourceType: 'summary', speakerLabels: [], startTime: null }))
      .toBe('[Session "The Crypt" — summary]');
  });
  it('dm_todo chunk', () => {
    expect(formatCitation({ sessionTitle: 'The Crypt', sourceType: 'dm_todo', speakerLabels: [], startTime: null }))
      .toBe('[Session "The Crypt" — DM TODO]');
  });
});
