import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isAiMocked, transcribeAudio, generateAiText, maxTranscriptionChunkSizeMB } from '@/lib/ai';

describe('ai service wrapper (mock mode)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('MOCK_AI_SERVICES', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('isAiMocked', () => {
    it('is true when MOCK_AI_SERVICES=true', () => {
      expect(isAiMocked()).toBe(true);
    });

    it('is false when MOCK_AI_SERVICES is unset or any other value', () => {
      vi.stubEnv('MOCK_AI_SERVICES', '');
      expect(isAiMocked()).toBe(false);
      vi.stubEnv('MOCK_AI_SERVICES', 'false');
      expect(isAiMocked()).toBe(false);
      vi.stubEnv('MOCK_AI_SERVICES', '1');
      expect(isAiMocked()).toBe(false);
    });
  });

  describe('transcribeAudio', () => {
    it('returns a deterministic transcript without hitting OpenAI', async () => {
      const first = await transcribeAudio(Buffer.from('ignored'));
      const second = await transcribeAudio(Buffer.from('different bytes'));

      expect(first.text).toBeTruthy();
      expect(first.text).toEqual(second.text);
    });
  });

  describe('generateAiText', () => {
    it('returns distinct deterministic text per kind', async () => {
      const summary = await generateAiText('any prompt', 'summary');
      const todo = await generateAiText('any prompt', 'dm-todo');

      expect(summary.text).toContain('Summary');
      expect(todo.text).toContain('TODO');
      expect(summary.text).not.toEqual(todo.text);
    });

    it('is deterministic across calls for the same kind', async () => {
      const a = await generateAiText('prompt A', 'summary');
      const b = await generateAiText('prompt B', 'summary');
      expect(a.text).toEqual(b.text);
    });
  });
});

describe('transcription provider selection (maxTranscriptionChunkSizeMB)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 18MB chunks (openai/whisper)', () => {
    expect(maxTranscriptionChunkSizeMB()).toBe(18);
    vi.stubEnv('AI_TRANSCRIPTION_PROVIDER', 'openai');
    expect(maxTranscriptionChunkSizeMB()).toBe(18);
    vi.stubEnv('AI_TRANSCRIPTION_PROVIDER', 'whisper-local');
    expect(maxTranscriptionChunkSizeMB()).toBe(18);
  });

  it('uses smaller 14MB chunks for google (Gemini inline request limit)', () => {
    vi.stubEnv('AI_TRANSCRIPTION_PROVIDER', 'google');
    expect(maxTranscriptionChunkSizeMB()).toBe(14);
  });

  it('falls back to the default for unknown providers', () => {
    vi.stubEnv('AI_TRANSCRIPTION_PROVIDER', 'not-a-provider');
    expect(maxTranscriptionChunkSizeMB()).toBe(18);
  });
});
