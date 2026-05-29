import { describe, expect, it } from 'vitest';
import {
  getRetentionConfig,
  isCronAuthorized,
  DEFAULT_AUDIO_RETENTION_DAYS,
  DEFAULT_SNIPPET_RETENTION_DAYS,
} from '../retention';

const DAY = 24 * 60 * 60 * 1000;
const env = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;

describe('getRetentionConfig', () => {
  it('uses design defaults when unset', () => {
    const c = getRetentionConfig(env({}));
    expect(c.audioRetentionMs).toBe(DEFAULT_AUDIO_RETENTION_DAYS * DAY);
    expect(c.snippetRetentionMs).toBe(DEFAULT_SNIPPET_RETENTION_DAYS * DAY);
  });

  it('parses configured day counts', () => {
    const c = getRetentionConfig(env({ AUDIO_RETENTION_DAYS: '7', UNKNOWN_SNIPPET_RETENTION_DAYS: '45' }));
    expect(c.audioRetentionMs).toBe(7 * DAY);
    expect(c.snippetRetentionMs).toBe(45 * DAY);
  });

  it('falls back on invalid or non-positive values', () => {
    const c = getRetentionConfig(env({ AUDIO_RETENTION_DAYS: 'abc', UNKNOWN_SNIPPET_RETENTION_DAYS: '0' }));
    expect(c.audioRetentionMs).toBe(DEFAULT_AUDIO_RETENTION_DAYS * DAY);
    expect(c.snippetRetentionMs).toBe(DEFAULT_SNIPPET_RETENTION_DAYS * DAY);
  });
});

describe('isCronAuthorized', () => {
  it('fails closed when CRON_SECRET is unset', () => {
    expect(isCronAuthorized('Bearer anything', env({}))).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(isCronAuthorized(null, env({ CRON_SECRET: 's3cret' }))).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(isCronAuthorized('Bearer nope', env({ CRON_SECRET: 's3cret' }))).toBe(false);
  });

  it('rejects a missing Bearer prefix', () => {
    expect(isCronAuthorized('s3cret', env({ CRON_SECRET: 's3cret' }))).toBe(false);
  });

  it('accepts the correct bearer secret', () => {
    expect(isCronAuthorized('Bearer s3cret', env({ CRON_SECRET: 's3cret' }))).toBe(true);
  });
});
