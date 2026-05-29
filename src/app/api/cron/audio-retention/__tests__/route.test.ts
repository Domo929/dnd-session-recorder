import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/retention', () => ({ purgeExpiredAudio: vi.fn() }));

import { purgeExpiredAudio } from '@/services/retention';
import { POST } from '../route';

function post(authHeader: string | null) {
  const headers: Record<string, string> = {};
  if (authHeader !== null) headers.authorization = authHeader;
  return new Request('http://localhost/api/cron/audio-retention', {
    method: 'POST',
    headers,
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', 's3cret');
  vi.mocked(purgeExpiredAudio).mockResolvedValue({ scanned: 3, purged: 2, failed: 1 });
});

describe('POST /api/cron/audio-retention', () => {
  it('401s without the secret', async () => {
    const res = await POST(post(null));
    expect(res.status).toBe(401);
    expect(purgeExpiredAudio).not.toHaveBeenCalled();
  });

  it('401s with a wrong secret', async () => {
    const res = await POST(post('Bearer nope'));
    expect(res.status).toBe(401);
  });

  it('runs the purge and returns counts with the correct secret', async () => {
    const res = await POST(post('Bearer s3cret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scanned: 3, purged: 2, failed: 1 });
    expect(purgeExpiredAudio).toHaveBeenCalledOnce();
  });

  it('500s when the purge throws', async () => {
    vi.mocked(purgeExpiredAudio).mockRejectedValueOnce(new Error('db down'));
    const res = await POST(post('Bearer s3cret'));
    expect(res.status).toBe(500);
  });
});
