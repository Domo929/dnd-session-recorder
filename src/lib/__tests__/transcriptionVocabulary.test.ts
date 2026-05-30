import { describe, it, expect } from 'vitest';
import {
  parseVocabularyTerms,
  buildVocabularyPromptSection,
  buildVocabularyPhraseHint,
  MAX_VOCABULARY_TERMS,
  MAX_TERM_LENGTH,
} from '@/lib/transcriptionVocabulary';

describe('parseVocabularyTerms', () => {
  it('returns [] for null/undefined/empty', () => {
    expect(parseVocabularyTerms(null)).toEqual([]);
    expect(parseVocabularyTerms(undefined)).toEqual([]);
    expect(parseVocabularyTerms('')).toEqual([]);
    expect(parseVocabularyTerms('   \n  ,  ')).toEqual([]);
  });

  it('splits on newlines and commas and trims', () => {
    expect(parseVocabularyTerms('Jabarquious\nVexil, Mournhold')).toEqual([
      'Jabarquious',
      'Vexil',
      'Mournhold',
    ]);
  });

  it('collapses repeated separators', () => {
    expect(parseVocabularyTerms('A,,\n\n , B')).toEqual(['A', 'B']);
  });

  it('de-duplicates case-insensitively, preserving first casing and order', () => {
    expect(parseVocabularyTerms('Vexil\nvexil\nVEXIL\nMournhold')).toEqual([
      'Vexil',
      'Mournhold',
    ]);
  });

  it('preserves multi-word terms', () => {
    expect(parseVocabularyTerms('Lord Vexil, The Sunken Keep')).toEqual([
      'Lord Vexil',
      'The Sunken Keep',
    ]);
  });

  it('drops terms longer than MAX_TERM_LENGTH', () => {
    const long = 'x'.repeat(MAX_TERM_LENGTH + 1);
    expect(parseVocabularyTerms(`Vexil,${long},Mournhold`)).toEqual([
      'Vexil',
      'Mournhold',
    ]);
  });

  it('caps the number of terms at MAX_VOCABULARY_TERMS', () => {
    const raw = Array.from({ length: MAX_VOCABULARY_TERMS + 25 }, (_, i) => `t${i}`).join(',');
    const result = parseVocabularyTerms(raw);
    expect(result).toHaveLength(MAX_VOCABULARY_TERMS);
    expect(result[0]).toBe('t0');
    expect(result[MAX_VOCABULARY_TERMS - 1]).toBe(`t${MAX_VOCABULARY_TERMS - 1}`);
  });
});

describe('buildVocabularyPromptSection', () => {
  it('returns empty string when there are no terms', () => {
    expect(buildVocabularyPromptSection(null)).toBe('');
    expect(buildVocabularyPromptSection('  ,  \n')).toBe('');
  });

  it('lists the terms and asks for exact spellings', () => {
    const section = buildVocabularyPromptSection('Jabarquious, Vexil');
    expect(section).toContain('Jabarquious');
    expect(section).toContain('Vexil');
    expect(section.toLowerCase()).toContain('exact spelling');
    expect(section.startsWith(' ')).toBe(true); // safe to concatenate
  });
});

describe('buildVocabularyPhraseHint', () => {
  it('returns empty string when there are no terms', () => {
    expect(buildVocabularyPhraseHint('')).toBe('');
  });

  it('joins normalized terms with commas', () => {
    expect(buildVocabularyPhraseHint('Jabarquious\nVexil\nvexil')).toBe(
      'Jabarquious, Vexil',
    );
  });
});
