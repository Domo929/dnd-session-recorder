import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  diceCoefficient,
  findBestNameMatch,
  canonicalizeName,
} from '@/lib/speakerNameMatch';

describe('normalizeName', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeName('  Bruce  ')).toBe('bruce');
    expect(normalizeName('Sir   Reginald')).toBe('sir reginald');
    expect(normalizeName('BRUCE')).toBe('bruce');
  });

  it('strips surrounding punctuation', () => {
    expect(normalizeName('"Bruce"')).toBe('bruce');
    expect(normalizeName('Bruce.')).toBe('bruce');
    expect(normalizeName('(Bruce)')).toBe('bruce');
  });

  it('keeps internal punctuation', () => {
    expect(normalizeName("Jack O'Lantern")).toBe("jack o'lantern");
  });
});

describe('diceCoefficient', () => {
  it('is 1 for identical normalized strings', () => {
    expect(diceCoefficient('Bruce', 'bruce')).toBe(1);
    expect(diceCoefficient('A', 'a')).toBe(1);
  });

  it('is 0 for disjoint names', () => {
    expect(diceCoefficient('Bruce', 'Alice')).toBeLessThan(0.5);
    expect(diceCoefficient('xyz', 'abc')).toBe(0);
  });

  it('scores a doubled/dropped letter high', () => {
    // "Thorin" vs "Thorinn" — clearly the same intended name.
    expect(diceCoefficient('Thorin', 'Thorinn')).toBeGreaterThan(0.8);
  });

  it('scores a single mid-word substitution moderately', () => {
    expect(diceCoefficient('Bruce', 'Bruse')).toBeCloseTo(0.5, 5);
  });

  it('returns 0 when one side is a single non-equal char', () => {
    expect(diceCoefficient('a', 'bruce')).toBe(0);
  });
});

describe('findBestNameMatch', () => {
  const registry = ['Bruce', 'Alice', 'Thorin', 'Narrator'];

  it('returns an exact normalized match with the canonical casing', () => {
    const m = findBestNameMatch('bruce', registry);
    expect(m).toEqual({ name: 'Bruce', score: 1, exact: true });
  });

  it('returns a fuzzy match for a typo above threshold', () => {
    const m = findBestNameMatch('Thorinn', registry);
    expect(m?.name).toBe('Thorin');
    expect(m?.exact).toBe(false);
  });

  it('returns null for a genuinely new name', () => {
    expect(findBestNameMatch('Zaphod', registry)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(findBestNameMatch('   ', registry)).toBeNull();
  });

  it('picks the highest-scoring candidate', () => {
    const m = findBestNameMatch('Alica', ['Alice', 'Alicia'], 0.5);
    expect(m?.name).toBe('Alice');
  });
});

describe('canonicalizeName', () => {
  const registry = ['Bruce', 'Alice'];

  it('snaps a differently-cased name to the canonical spelling', () => {
    expect(canonicalizeName('BRUCE', registry)).toBe('Bruce');
    expect(canonicalizeName('  bruce ', registry)).toBe('Bruce');
  });

  it('returns the trimmed input for a new name', () => {
    expect(canonicalizeName('  Zaphod ', registry)).toBe('Zaphod');
  });
});
