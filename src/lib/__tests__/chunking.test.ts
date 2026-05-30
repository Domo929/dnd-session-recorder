import { describe, it, expect } from 'vitest';
import { buildTranscriptChunks, type Segment } from '@/lib/chunking';

const seg = (text: string, start: number, end: number, speaker?: string): Segment =>
  ({ text, startTime: start, endTime: end, speakerLabel: speaker ?? null });

describe('buildTranscriptChunks', () => {
  it('merges short segments into one window with combined timing', () => {
    const chunks = buildTranscriptChunks([seg('a', 0, 1, 'Thalia'), seg('b', 1, 2, 'Thalia')], { maxChars: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startTime).toBe(0);
    expect(chunks[0].endTime).toBe(2);
    expect(chunks[0].text).toBe('a b');
    expect(chunks[0].speakerLabels).toEqual(['Thalia']);
  });

  it('collects the distinct, order-preserved set of speakers', () => {
    const chunks = buildTranscriptChunks(
      [seg('a', 0, 1, 'Thalia'), seg('b', 1, 2, 'Bren'), seg('c', 2, 3, 'Thalia')],
      { maxChars: 100 },
    );
    expect(chunks[0].speakerLabels).toEqual(['Thalia', 'Bren']);
  });

  it('splits into multiple windows when maxChars is exceeded', () => {
    const chunks = buildTranscriptChunks([seg('aaaa', 0, 1), seg('bbbb', 1, 2)], { maxChars: 5 });
    expect(chunks.length).toBe(2);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[1].chunkIndex).toBe(1);
  });

  it('ignores null speakers in the set', () => {
    const chunks = buildTranscriptChunks([seg('a', 0, 1), seg('b', 1, 2, 'Bren')], { maxChars: 100 });
    expect(chunks[0].speakerLabels).toEqual(['Bren']);
  });

  it('returns an empty array for no segments', () => {
    expect(buildTranscriptChunks([], {})).toEqual([]);
  });
});
