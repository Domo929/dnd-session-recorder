import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/retention', () => ({ purgeExpiredSnippets: vi.fn() }));

import { purgeExpiredSnippets } from '@/services/retention';
import { POST } from '../route';

function post(authHeader: string | null) {
  const headers: Record<string, string> = {};
  if (authHeader !== null) headers.authorization = authHeader;
  return new Request('http://localhost/api/cron/snippet-purge', {
    method: 'POST',
    headers,
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', 's3cret');
  vi.mocked(purgeExpiredSnippets).mockResolvedValue({ scanned: 1, purged: 1, failed: 0 });
});

describe('POST /api/cron/snippet-purge', () => {
  it('401s without the secret', async () => {
    const res = await POST(post(null));
    expect(res.status).toBe(401);
    expect(purgeExpiredSnippets).not.toHaveBeenCalled();
  });

  it('runs the purge and returns counts with the correct secret', async () => {
    const res = await POST(post('Bearer s3cret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scanned: 1, purged: 1, failed: 0 });
    expect(purgeExpiredSnippets).toHaveBeenCalledOnce();
  });

  it('500s when the purge throws', async () => {
    vi.mocked(purgeExpiredSnippets).mockRejectedValueOnce(new Error('boom'));
    const res = await POST(post('Bearer s3cret'));
    expect(res.status).toBe(500);
  });
});
