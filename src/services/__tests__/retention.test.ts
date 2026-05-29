import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/database', () => ({ db: {} }));
vi.mock('@/services/storage', () => ({ getStorageService: vi.fn() }));

import { db } from '@/services/database';
import { getStorageService } from '@/services/storage';
import { purgeExpiredAudio, purgeExpiredSnippets } from '../retention';

let del: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  del = vi.fn(async () => {});
  vi.mocked(getStorageService).mockReturnValue({ delete: del } as never);
  Object.assign(db as unknown as Record<string, unknown>, {
    getExpiredAudioUploads: vi.fn(async () => []),
    markAudioPurged: vi.fn(async () => {}),
    getExpiredSnippetClusters: vi.fn(async () => []),
    clearClusterSnippet: vi.fn(async () => {}),
  });
});

describe('purgeExpiredAudio', () => {
  it('deletes the blob and tombstones each expired upload', async () => {
    (db.getExpiredAudioUploads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'u1', path: 'uploads/a.m4a', storage: 'blob' },
      { id: 'u2', path: 'uploads/b.m4a', storage: 'blob' },
    ]);
    const res = await purgeExpiredAudio();
    expect(res).toEqual({ scanned: 2, purged: 2, failed: 0 });
    expect(del).toHaveBeenCalledWith('uploads/a.m4a');
    expect(db.markAudioPurged).toHaveBeenCalledWith('u1');
    expect(db.markAudioPurged).toHaveBeenCalledWith('u2');
  });

  it('isolates a per-upload failure and keeps going', async () => {
    (db.getExpiredAudioUploads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'u1', path: 'a', storage: 'blob' },
      { id: 'u2', path: 'b', storage: 'blob' },
    ]);
    del.mockRejectedValueOnce(new Error('blob gone'));
    const res = await purgeExpiredAudio();
    expect(res).toEqual({ scanned: 2, purged: 1, failed: 1 });
    // The failed upload is NOT tombstoned, so it is retried next run.
    expect(db.markAudioPurged).toHaveBeenCalledTimes(1);
    expect(db.markAudioPurged).toHaveBeenCalledWith('u2');
  });

  it('is a no-op when nothing has expired', async () => {
    const res = await purgeExpiredAudio();
    expect(res).toEqual({ scanned: 0, purged: 0, failed: 0 });
    expect(del).not.toHaveBeenCalled();
  });
});

describe('purgeExpiredSnippets', () => {
  it('deletes the snippet and clears it on the cluster', async () => {
    (db.getExpiredSnippetClusters as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'c1', snippetBlobPath: 'voice-samples/clusters/s/1.opus' },
    ]);
    const res = await purgeExpiredSnippets();
    expect(res).toEqual({ scanned: 1, purged: 1, failed: 0 });
    expect(del).toHaveBeenCalledWith('voice-samples/clusters/s/1.opus');
    expect(db.clearClusterSnippet).toHaveBeenCalledWith('c1');
  });

  it('isolates a per-snippet failure', async () => {
    (db.getExpiredSnippetClusters as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'c1', snippetBlobPath: 'a' },
      { id: 'c2', snippetBlobPath: 'b' },
    ]);
    del.mockRejectedValueOnce(new Error('boom'));
    const res = await purgeExpiredSnippets();
    expect(res).toEqual({ scanned: 2, purged: 1, failed: 1 });
    expect(db.clearClusterSnippet).toHaveBeenCalledTimes(1);
    expect(db.clearClusterSnippet).toHaveBeenCalledWith('c2');
  });
});
