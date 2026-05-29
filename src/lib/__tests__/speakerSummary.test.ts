import { describe, it, expect } from 'vitest';
import { buildSpeakerSummaryPrompt, formatSpeakerTranscript } from '../speakerSummary';

const turns = [
  { label: 'Thorin', startSec: 12, text: 'I kick the door down.' },
  { label: 'DM (narration)', startSec: 14, text: 'The door splinters.' },
];

describe('formatSpeakerTranscript', () => {
  it('formats [mm:ss] Label: "text" lines', () => {
    expect(formatSpeakerTranscript(turns)).toBe(
      '[0:12] Thorin: "I kick the door down."\n[0:14] DM (narration): "The door splinters."',
    );
  });
});

describe('buildSpeakerSummaryPrompt', () => {
  it('includes the roster, transcript, and structure headers', () => {
    const prompt = buildSpeakerSummaryPrompt({
      roster: ['Thorin (PC, played by alice@example.com)', 'DM (narration)'],
      turns,
    });
    expect(prompt).toContain('Speakers in this session:');
    expect(prompt).toContain('- Thorin (PC, played by alice@example.com)');
    expect(prompt).toContain('[0:12] Thorin: "I kick the door down."');
    expect(prompt).toContain('1. What happened (chronological)');
    expect(prompt).toContain('Key NPCs encountered');
  });

  it('embeds campaign context when provided', () => {
    const prompt = buildSpeakerSummaryPrompt({
      roster: [],
      turns,
      campaignSystemPrompt: 'Grim dark setting.',
    });
    expect(prompt).toContain('Campaign Context:\nGrim dark setting.');
    expect(prompt).toContain('- (no identified speakers)');
  });

  it('omits campaign context block when blank', () => {
    const prompt = buildSpeakerSummaryPrompt({ roster: ['x'], turns, campaignSystemPrompt: '   ' });
    expect(prompt).not.toContain('Campaign Context:');
  });
});
