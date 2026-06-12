import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/storage', () => ({ getStorageService: vi.fn() }));
vi.mock('@/services/database', () => ({ db: { createUpload: vi.fn() } }));
vi.mock('@/services/audioProcessing', () => ({ getAudioDuration: vi.fn() }));

import { getStorageService } from '@/services/storage';
import { db } from '@/services/database';
import { getAudioDuration } from '@/services/audioProcessing';
import {
  createUploadFromBlob,
  UploadCompletionError,
} from '@/services/storage/createUploadFromBlob';

const userId = 'user_1';
const ownedBlob = 'uploads/user_1/123-uuid.m4a';
const base = { originalName: 'a.m4a', mimetype: 'audio/mp4', size: 2048 };

function mockStorage(over: Partial<Record<string, unknown>> = {}) {
  const head = vi.fn(async () => ({ exists: true, size: 2048 }));
  const del = vi.fn(async () => {});
  const materializeToTempFile = vi.fn(async () => '/tmp/does-not-exist-xyz.m4a');
  vi.mocked(getStorageService).mockReturnValue({
    head,
    delete: del,
    materializeToTempFile,
    ...over,
  } as never);
  return { head, del, materializeToTempFile };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAudioDuration).mockResolvedValue(123.7);
  vi.mocked(db.createUpload).mockResolvedValue({ id: 'up_1', filename: '123-uuid.m4a' } as never);
});

describe('createUploadFromBlob', () => {
  it('rejects a disallowed mime with 400', async () => {
    mockStorage();
    await expect(
      createUploadFromBlob(userId, { ...base, blobPath: ownedBlob, mimetype: 'text/plain' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a blob owned by another user with 403', async () => {
    mockStorage();
    await expect(
      createUploadFromBlob(userId, { ...base, blobPath: 'uploads/user_2/x.m4a' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('404 when the blob never landed', async () => {
    mockStorage({ head: vi.fn(async () => ({ exists: false, size: 0 })) });
    await expect(
      createUploadFromBlob(userId, { ...base, blobPath: ownedBlob }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('422 and deletes the orphan blob when the real size differs from the declared size', async () => {
    const { del } = mockStorage({ head: vi.fn(async () => ({ exists: true, size: 9999 })) });
    await expect(
      createUploadFromBlob(userId, { ...base, blobPath: ownedBlob, size: 2048 }),
    ).rejects.toMatchObject({ status: 422 });
    expect(del).toHaveBeenCalledWith(ownedBlob);
  });

  it('422 and deletes the orphan blob when ffprobe fails', async () => {
    const { del } = mockStorage();
    vi.mocked(getAudioDuration).mockRejectedValue(new Error('not audio'));
    await expect(
      createUploadFromBlob(userId, { ...base, blobPath: ownedBlob }),
    ).rejects.toBeInstanceOf(UploadCompletionError);
    expect(del).toHaveBeenCalledWith(ownedBlob);
  });

  it('creates a blob-backed Upload row on success', async () => {
    mockStorage();
    const upload = await createUploadFromBlob(userId, { ...base, blobPath: ownedBlob });
    expect(upload.id).toBe('up_1');
    expect(db.createUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        path: ownedBlob,
        filename: '123-uuid.m4a',
        storage: 'blob',
        size: 2048,
        duration: 124,
      }),
    );
  });
});
