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

  describe('embedTexts', () => {
    it('returns 768-dim deterministic vectors without hitting Gemini', async () => {
      const { embedTexts } = await import('@/lib/ai');
      const [a] = await embedTexts(['hello']);
      const [b] = await embedTexts(['hello']);
      const [c] = await embedTexts(['different']);
      expect(a).toHaveLength(768);
      expect(a).toEqual(b);
      expect(a).not.toEqual(c);
    });

    it('returns one vector per input text', async () => {
      const { embedTexts } = await import('@/lib/ai');
      const out = await embedTexts(['one', 'two', 'three']);
      expect(out).toHaveLength(3);
    });
  });

  describe('buildChatMessages', () => {
    it('prepends a system message containing the context and keeps history order', async () => {
      const { buildChatMessages } = await import('@/lib/ai');
      const history = [
        { role: 'user' as const, content: 'Who is the villain?' },
        { role: 'assistant' as const, content: 'Let me check.' },
        { role: 'user' as const, content: 'Any update?' },
      ];
      const messages = buildChatMessages('CTX-MARKER', history);

      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('CTX-MARKER');
      expect(messages.slice(1)).toEqual(history);
    });
  });

  describe('streamCampaignChat (mock mode)', () => {
    it('streams a deterministic answer echoing a citation tag from the context', async () => {
      const { buildChatMessages, streamCampaignChat } = await import('@/lib/ai');
      const context = '[Session "Goblin Ambush" @ 0:01:23, Alice]\nThe party fought goblins.';
      const messages = buildChatMessages(context, [
        { role: 'user', content: 'What happened with the goblins?' },
      ]);

      const res = streamCampaignChat(messages).toTextStreamResponse();
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).toContain('[Session "Goblin Ambush" @ 0:01:23, Alice]');
    });

    it('says it could not find an answer when the context has no citations', async () => {
      const { buildChatMessages, streamCampaignChat } = await import('@/lib/ai');
      const messages = buildChatMessages('', [
        { role: 'user', content: 'Who is the king?' },
      ]);

      const text = await streamCampaignChat(messages).toTextStreamResponse().text();
      expect(text.toLowerCase()).toContain('could not find');
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
