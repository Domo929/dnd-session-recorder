import { describe, it, expect } from 'vitest';
import { formatTimestamp, groupTurns } from '../speakerTranscript';

describe('formatTimestamp', () => {
  it('formats sub-hour as mm:ss', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(12)).toBe('0:12');
    expect(formatTimestamp(75)).toBe('1:15');
  });

  it('formats past an hour as h:mm:ss', () => {
    expect(formatTimestamp(3661)).toBe('1:01:01');
  });

  it('clamps negatives to 0:00', () => {
    expect(formatTimestamp(-5)).toBe('0:00');
  });
});

describe('groupTurns', () => {
  it('collapses consecutive same-cluster rows', () => {
    const turns = groupTurns([
      { speakerClusterId: 'c1', startTime: 0, text: 'I kick' },
      { speakerClusterId: 'c1', startTime: 2, text: 'the door down.' },
      { speakerClusterId: 'c2', startTime: 5, text: 'The door splinters.' },
      { speakerClusterId: 'c1', startTime: 8, text: 'Nice.' },
    ]);
    expect(turns).toEqual([
      { speakerClusterId: 'c1', startTime: 0, text: 'I kick the door down.' },
      { speakerClusterId: 'c2', startTime: 5, text: 'The door splinters.' },
      { speakerClusterId: 'c1', startTime: 8, text: 'Nice.' },
    ]);
  });

  it('keeps the first row start time for a turn', () => {
    const [turn] = groupTurns([
      { speakerClusterId: 'c1', startTime: 10, text: 'a' },
      { speakerClusterId: 'c1', startTime: 20, text: 'b' },
    ]);
    expect(turn.startTime).toBe(10);
  });

  it('groups adjacent null clusters together but not across a different cluster', () => {
    const turns = groupTurns([
      { speakerClusterId: null, startTime: 0, text: 'x' },
      { speakerClusterId: null, startTime: 1, text: 'y' },
      { speakerClusterId: 'c1', startTime: 2, text: 'z' },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ speakerClusterId: null, startTime: 0, text: 'x y' });
  });

  it('returns [] for no rows', () => {
    expect(groupTurns([])).toEqual([]);
  });
});
