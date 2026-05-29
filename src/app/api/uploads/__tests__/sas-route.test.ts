import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-utils', () => ({ requireAuth: vi.fn() }));
vi.mock('@/services/storage', () => ({ getStorageService: vi.fn() }));

import { requireAuth } from '@/lib/auth-utils';
import { getStorageService } from '@/services/storage';
import { POST } from '../sas/route';

function jsonRequest(body: unknown) {
  return new Request('http://localhost/api/uploads/sas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const authed = { id: 'user_1', email: 'dm@example.com' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({ error: null, user: authed } as never);
  delete process.env.MAX_FILE_SIZE;
});

describe('POST /api/uploads/sas', () => {
  it('returns the auth error when not signed in', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      user: null,
    } as never);
    const res = await POST(jsonRequest({ originalName: 'a.m4a', mimetype: 'audio/mp4', size: 1 }));
    expect(res.status).toBe(401);
  });

  it('400 on missing fields', async () => {
    const res = await POST(jsonRequest({ originalName: 'a.m4a' }));
    expect(res.status).toBe(400);
  });

  it('400 on disallowed mime', async () => {
    const res = await POST(jsonRequest({ originalName: 'a.txt', mimetype: 'text/plain', size: 1 }));
    expect(res.status).toBe(400);
  });

  it('413 when size exceeds the cap', async () => {
    process.env.MAX_FILE_SIZE = '1000';
    const res = await POST(jsonRequest({ originalName: 'a.m4a', mimetype: 'audio/mp4', size: 2000 }));
    expect(res.status).toBe(413);
  });

  it('200 with sasUrl + blobPath on success', async () => {
    const issueUploadUrl = vi.fn(async () => ({
      uploadUrl: 'https://blob/audio-sessions/uploads/user_1/x.m4a?sig=...',
      blobPath: 'uploads/user_1/x.m4a',
      expiresAt: new Date('2026-05-29T00:30:00Z'),
    }));
    vi.mocked(getStorageService).mockReturnValue({ issueUploadUrl } as never);

    const res = await POST(jsonRequest({ originalName: 'a.m4a', mimetype: 'audio/mp4', size: 1024 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blobPath).toBe('uploads/user_1/x.m4a');
    expect(body.sasUrl).toContain('sig=');
    expect(issueUploadUrl).toHaveBeenCalledWith({
      userId: 'user_1',
      originalName: 'a.m4a',
      mimetype: 'audio/mp4',
      size: 1024,
    });
  });

  it('503 when the storage backend cannot issue a URL', async () => {
    vi.mocked(getStorageService).mockReturnValue({
      issueUploadUrl: vi.fn(async () => {
        throw new Error('no delegation key');
      }),
    } as never);
    const res = await POST(jsonRequest({ originalName: 'a.m4a', mimetype: 'audio/mp4', size: 1 }));
    expect(res.status).toBe(503);
  });
});
