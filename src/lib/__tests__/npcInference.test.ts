import { describe, it, expect } from 'vitest';
import { buildNpcInferencePrompt, parseNpcSuggestions } from '../npcInference';

describe('buildNpcInferencePrompt', () => {
  it('lists the unknown labels and asks for JSON', () => {
    const prompt = buildNpcInferencePrompt({
      unknownLabels: ['DM (Unknown #2)'],
      turns: [{ label: 'Thorin', startSec: 870, text: 'Captain, hold!' }],
    });
    expect(prompt).toContain('- DM (Unknown #2)');
    expect(prompt).toContain('[14:30] Thorin: "Captain, hold!"');
    expect(prompt).toContain('JSON array');
  });
});

describe('parseNpcSuggestions', () => {
  const allowed = ['DM (Unknown #2)', 'DM (Unknown #3)'];

  it('parses a clean JSON array, keeping only allowed labels', () => {
    const text = JSON.stringify([
      { label: 'DM (Unknown #2)', suggestedName: 'Captain Voss', confidence: 'high', reasoning: 'Addressed as Captain at 14:32.' },
      { label: 'DM (Unknown #9)', suggestedName: 'Ghost', confidence: 'low', reasoning: 'n/a' },
    ]);
    const out = parseNpcSuggestions(text, allowed);
    expect(out).toEqual([
      { label: 'DM (Unknown #2)', suggestedName: 'Captain Voss', confidence: 'high', reasoning: 'Addressed as Captain at 14:32.' },
    ]);
  });

  it('strips a ```json code fence', () => {
    const text = '```json\n[{"label":"DM (Unknown #3)","suggestedName":"Mara","confidence":"medium","reasoning":"Self-identifies."}]\n```';
    const out = parseNpcSuggestions(text, allowed);
    expect(out).toHaveLength(1);
    expect(out[0].suggestedName).toBe('Mara');
  });

  it('de-duplicates by label', () => {
    const text = JSON.stringify([
      { label: 'DM (Unknown #2)', suggestedName: 'A', confidence: 'low', reasoning: 'r' },
      { label: 'DM (Unknown #2)', suggestedName: 'B', confidence: 'low', reasoning: 'r' },
    ]);
    expect(parseNpcSuggestions(text, allowed)).toHaveLength(1);
  });

  it('returns [] on invalid JSON or non-array', () => {
    expect(parseNpcSuggestions('not json', allowed)).toEqual([]);
    expect(parseNpcSuggestions('{"label":"x"}', allowed)).toEqual([]);
  });

  it('drops entries with a bad confidence value', () => {
    const text = JSON.stringify([
      { label: 'DM (Unknown #2)', suggestedName: 'A', confidence: 'certain', reasoning: 'r' },
    ]);
    expect(parseNpcSuggestions(text, allowed)).toEqual([]);
  });
});
