import { describe, it, expect } from 'vitest';
import {
  parseSpeakerTurns,
  hasSpeakerLabels,
  speakerColorIndex,
  buildTurns,
  resolveTurnName,
} from '@/lib/transcriptFormat';

describe('parseSpeakerTurns', () => {
  it('returns an empty array for empty / whitespace input', () => {
    expect(parseSpeakerTurns('')).toEqual([]);
    expect(parseSpeakerTurns('   \n  ')).toEqual([]);
  });

  it('returns a single unattributed turn when there are no labels', () => {
    expect(parseSpeakerTurns('Just a plain wall of text.')).toEqual([
      { speaker: null, text: 'Just a plain wall of text.' },
    ]);
  });

  it('splits multiple speaker turns', () => {
    const text =
      'Speaker 1: We enter the keep. Speaker 2: I check for traps. Speaker 1: Good idea.';
    expect(parseSpeakerTurns(text)).toEqual([
      { speaker: 'Speaker 1', text: 'We enter the keep.' },
      { speaker: 'Speaker 2', text: 'I check for traps.' },
      { speaker: 'Speaker 1', text: 'Good idea.' },
    ]);
  });

  it('captures unattributed lead-in text before the first label', () => {
    const text = 'The session begins. Speaker 1: Hello everyone.';
    expect(parseSpeakerTurns(text)).toEqual([
      { speaker: null, text: 'The session begins.' },
      { speaker: 'Speaker 1', text: 'Hello everyone.' },
    ]);
  });

  it('handles a leading label with no lead-in', () => {
    expect(parseSpeakerTurns('Speaker 1: Hi.')).toEqual([
      { speaker: 'Speaker 1', text: 'Hi.' },
    ]);
  });

  it('normalizes odd whitespace around the label and colon', () => {
    const text = 'Speaker  2 :   spaced out';
    expect(parseSpeakerTurns(text)).toEqual([
      { speaker: 'Speaker 2', text: 'spaced out' },
    ]);
  });

  it('supports alphanumeric labels', () => {
    const text = 'Speaker A: first. Speaker B: second.';
    expect(parseSpeakerTurns(text)).toEqual([
      { speaker: 'Speaker A', text: 'first.' },
      { speaker: 'Speaker B', text: 'second.' },
    ]);
  });

  it('does not treat an ordinary mid-sentence colon as a label', () => {
    const text = 'Speaker 1: Note: bring the map next time.';
    expect(parseSpeakerTurns(text)).toEqual([
      { speaker: 'Speaker 1', text: 'Note: bring the map next time.' },
    ]);
  });

  it('keeps a label whose turn has no following text', () => {
    const text = 'Speaker 1: Speaker 2: actually I go first.';
    expect(parseSpeakerTurns(text)).toEqual([
      { speaker: 'Speaker 1', text: '' },
      { speaker: 'Speaker 2', text: 'actually I go first.' },
    ]);
  });
});

describe('hasSpeakerLabels', () => {
  it('detects inline speaker labels', () => {
    expect(hasSpeakerLabels('Speaker 1: hi there')).toBe(true);
    expect(hasSpeakerLabels('mid Speaker 3: text')).toBe(true);
  });

  it('is false for unlabeled text', () => {
    expect(hasSpeakerLabels('no labels here, just prose')).toBe(false);
    expect(hasSpeakerLabels('')).toBe(false);
  });

  it('is stateless across calls (global regex lastIndex reset)', () => {
    const t = 'Speaker 1: a';
    expect(hasSpeakerLabels(t)).toBe(true);
    expect(hasSpeakerLabels(t)).toBe(true);
  });
});

describe('speakerColorIndex', () => {
  it('maps numeric speakers by their number modulo the palette', () => {
    expect(speakerColorIndex('Speaker 1', 4)).toBe(1);
    expect(speakerColorIndex('Speaker 5', 4)).toBe(1);
    expect(speakerColorIndex('Speaker 4', 4)).toBe(0);
  });

  it('returns 0 for null speakers or empty palette', () => {
    expect(speakerColorIndex(null, 4)).toBe(0);
    expect(speakerColorIndex('Speaker 1', 0)).toBe(0);
  });

  it('is deterministic and in-range for non-numeric labels', () => {
    const a = speakerColorIndex('Alice', 5);
    const b = speakerColorIndex('Alice', 5);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(5);
  });
});

describe('buildTurns', () => {
  it('assigns a stable contiguous turnIndex across rows', () => {
    const turns = buildTurns([
      { text: 'Speaker 1: hello Speaker 2: hi' },
      { text: 'Speaker 1: again' },
    ]);
    expect(turns).toEqual([
      { turnIndex: 0, speakerKey: 'Speaker 1', text: 'hello' },
      { turnIndex: 1, speakerKey: 'Speaker 2', text: 'hi' },
      { turnIndex: 2, speakerKey: 'Speaker 1', text: 'again' },
    ]);
  });

  it('represents an unattributed lead-in as a null speakerKey turn', () => {
    const turns = buildTurns([{ text: 'intro words Speaker 1: hi' }]);
    expect(turns[0]).toEqual({ turnIndex: 0, speakerKey: null, text: 'intro words' });
    expect(turns[1].speakerKey).toBe('Speaker 1');
  });

  it('returns an empty list for empty rows', () => {
    expect(buildTurns([])).toEqual([]);
    expect(buildTurns([{ text: '   ' }])).toEqual([]);
  });
});

describe('resolveTurnName', () => {
  const turns = buildTurns([{ text: 'Speaker 1: a Speaker 2: b Speaker 1: c' }]);

  it('falls back to the raw speaker key with no labels', () => {
    expect(resolveTurnName(turns[0], {}, {})).toBe('Speaker 1');
  });

  it('applies a per-speaker-key default', () => {
    expect(resolveTurnName(turns[0], { 'Speaker 1': 'Bruce' }, {})).toBe('Bruce');
    expect(resolveTurnName(turns[2], { 'Speaker 1': 'Bruce' }, {})).toBe('Bruce');
  });

  it('lets a per-turn override win over the default', () => {
    const defaults = { 'Speaker 1': 'Bruce' };
    const overrides = { 2: 'Alice' };
    expect(resolveTurnName(turns[0], defaults, overrides)).toBe('Bruce');
    expect(resolveTurnName(turns[2], defaults, overrides)).toBe('Alice');
  });

  it('returns null for an unattributed turn with no override', () => {
    const lead = buildTurns([{ text: 'just words' }])[0];
    expect(resolveTurnName(lead, {}, {})).toBeNull();
  });
});
