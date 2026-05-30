import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getBackoffConfig,
  transcriptionMinIntervalMs,
  isRetryableTranscriptionError,
  parseRetryDelayMs,
  computeBackoffMs,
  createTranscriptionPacer,
  transcribeWithBackoff,
  type BackoffConfig,
} from '@/lib/ai';

const TEST_CONFIG: BackoffConfig = { maxRetries: 3, baseMs: 5000, maxMs: 60000 };

describe('getBackoffConfig', () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it('uses safe defaults', () => {
    expect(getBackoffConfig()).toEqual({ maxRetries: 5, baseMs: 5000, maxMs: 60000 });
  });

  it('reads env overrides', () => {
    vi.stubEnv('TRANSCRIPTION_CHUNK_MAX_RETRIES', '2');
    vi.stubEnv('TRANSCRIPTION_BACKOFF_BASE_MS', '1000');
    vi.stubEnv('TRANSCRIPTION_BACKOFF_MAX_MS', '8000');
    expect(getBackoffConfig()).toEqual({ maxRetries: 2, baseMs: 1000, maxMs: 8000 });
  });

  it('never lets maxMs fall below baseMs', () => {
    vi.stubEnv('TRANSCRIPTION_BACKOFF_BASE_MS', '9000');
    vi.stubEnv('TRANSCRIPTION_BACKOFF_MAX_MS', '1000');
    expect(getBackoffConfig().maxMs).toBe(9000);
  });

  it('ignores invalid env values', () => {
    vi.stubEnv('TRANSCRIPTION_CHUNK_MAX_RETRIES', 'nonsense');
    expect(getBackoffConfig().maxRetries).toBe(5);
  });
});

describe('transcriptionMinIntervalMs', () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to 60 RPM (1s gap)', () => {
    expect(transcriptionMinIntervalMs()).toBe(1000);
  });

  it('derives the gap from TRANSCRIPTION_MAX_RPM', () => {
    vi.stubEnv('TRANSCRIPTION_MAX_RPM', '30');
    expect(transcriptionMinIntervalMs()).toBe(2000);
    vi.stubEnv('TRANSCRIPTION_MAX_RPM', '120');
    expect(transcriptionMinIntervalMs()).toBe(500);
  });
});

describe('isRetryableTranscriptionError', () => {
  it('treats rate-limit / overload errors as retryable', () => {
    expect(isRetryableTranscriptionError(new Error('429 RESOURCE_EXHAUSTED'))).toBe(true);
    expect(isRetryableTranscriptionError(new Error('This model is currently experiencing high demand.'))).toBe(true);
    expect(isRetryableTranscriptionError(new Error('You exceeded your current quota'))).toBe(true);
    expect(isRetryableTranscriptionError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isRetryableTranscriptionError({ statusCode: 429, message: 'too many' })).toBe(true);
  });

  it('treats hard errors as non-retryable', () => {
    expect(isRetryableTranscriptionError(new Error('Invalid audio format'))).toBe(false);
    expect(isRetryableTranscriptionError({ statusCode: 401, message: 'unauthorized' })).toBe(false);
    expect(isRetryableTranscriptionError({ status: 400, message: 'bad request' })).toBe(false);
  });
});

describe('parseRetryDelayMs', () => {
  it('parses Gemini "retry in Xs" hints', () => {
    expect(parseRetryDelayMs(new Error('Please retry in 58.458785557s.'))).toBe(58459);
    expect(parseRetryDelayMs(new Error('retry in 5s'))).toBe(5000);
  });

  it('parses structured retryDelay fields', () => {
    expect(parseRetryDelayMs(new Error('{"retryDelay":"42s"}'))).toBe(42000);
  });

  it('parses a numeric Retry-After response header', () => {
    expect(parseRetryDelayMs({ responseHeaders: { 'retry-after': '30' } })).toBe(30000);
    expect(parseRetryDelayMs({ responseHeaders: { 'retry-after': 12 } })).toBe(12000);
  });

  it('returns null when there is no hint', () => {
    expect(parseRetryDelayMs(new Error('something went wrong'))).toBeNull();
  });
});

describe('computeBackoffMs', () => {
  it('honors the server hint, capped at maxMs', () => {
    expect(computeBackoffMs(0, TEST_CONFIG, 58000)).toBe(58000);
    expect(computeBackoffMs(0, TEST_CONFIG, 999999)).toBe(60000);
  });

  it('falls back to exponential backoff capped at maxMs', () => {
    expect(computeBackoffMs(0, TEST_CONFIG, null)).toBe(5000);
    expect(computeBackoffMs(1, TEST_CONFIG, null)).toBe(15000);
    expect(computeBackoffMs(2, TEST_CONFIG, null)).toBe(45000);
    expect(computeBackoffMs(3, TEST_CONFIG, null)).toBe(60000);
  });
});

describe('createTranscriptionPacer', () => {
  it('sleeps only when calls arrive faster than the min interval', async () => {
    let clock = 0;
    const slept: number[] = [];
    const pace = createTranscriptionPacer(1000, {
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    await pace(); // first call: no wait, last = 0
    expect(slept).toEqual([]);

    await pace(); // immediately after: full gap
    expect(slept).toEqual([1000]);

    clock += 400; // 400ms elapses on its own
    await pace(); // needs another 600ms
    expect(slept).toEqual([1000, 600]);

    clock += 5000; // plenty of time passes
    await pace(); // no wait
    expect(slept).toEqual([1000, 600]);
  });
});

describe('transcribeWithBackoff', () => {
  it('returns immediately on success without sleeping', async () => {
    const slept: number[] = [];
    const transcribeFn = vi.fn(async () => ({ text: 'ok' }));
    const result = await transcribeWithBackoff(Buffer.from('a'), {
      transcribeFn,
      sleep: async (ms) => void slept.push(ms),
      config: TEST_CONFIG,
    });
    expect(result.text).toBe('ok');
    expect(transcribeFn).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it('retries retryable errors honoring the server hint, then succeeds', async () => {
    const slept: number[] = [];
    const transcribeFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 RESOURCE_EXHAUSTED. Please retry in 7s'))
      .mockRejectedValueOnce(new Error('high demand'))
      .mockResolvedValueOnce({ text: 'finally' });

    const result = await transcribeWithBackoff(Buffer.from('a'), {
      transcribeFn,
      sleep: async (ms) => void slept.push(ms),
      config: TEST_CONFIG,
    });

    expect(result.text).toBe('finally');
    expect(transcribeFn).toHaveBeenCalledTimes(3);
    // first retry honors 7s hint, second falls back to exponential attempt 1 (15s)
    expect(slept).toEqual([7000, 15000]);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    const transcribeFn = vi.fn().mockRejectedValue(new Error('429 quota'));
    await expect(
      transcribeWithBackoff(Buffer.from('a'), {
        transcribeFn,
        sleep: async () => {},
        config: { maxRetries: 2, baseMs: 1000, maxMs: 5000 },
      }),
    ).rejects.toThrow('429 quota');
    expect(transcribeFn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('rethrows non-retryable errors immediately', async () => {
    const transcribeFn = vi.fn().mockRejectedValue(new Error('Invalid audio format'));
    await expect(
      transcribeWithBackoff(Buffer.from('a'), {
        transcribeFn,
        sleep: async () => {},
        config: TEST_CONFIG,
      }),
    ).rejects.toThrow('Invalid audio format');
    expect(transcribeFn).toHaveBeenCalledTimes(1);
  });
});
