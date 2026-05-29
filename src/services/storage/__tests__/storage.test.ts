import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalDiskStorageService } from '../local';
import { buildBlobPath, blobPathOwnedBy } from '../types';

vi.mock('../index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index')>();
  return { ...actual, getStorageService: vi.fn() };
});

import { createStorageService, getStorageService } from '../index';
import { withMaterializedAudio } from '../materialize';

const AZURITE_CONN =
  'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';

describe('blob path helpers', () => {
  it('namespaces blobs under the user id', () => {
    expect(buildBlobPath('user_1', '123-abc.m4a')).toBe('uploads/user_1/123-abc.m4a');
  });

  it('detects ownership by path prefix', () => {
    const p = buildBlobPath('user_1', 'f.m4a');
    expect(blobPathOwnedBy(p, 'user_1')).toBe(true);
    expect(blobPathOwnedBy(p, 'user_2')).toBe(false);
    expect(blobPathOwnedBy('uploads/user_12/f.m4a', 'user_1')).toBe(false);
  });
});

describe('createStorageService selection', () => {
  it('defaults to local disk with no env', () => {
    expect(createStorageService({} as NodeJS.ProcessEnv).backend).toBe('local');
  });

  it('prefers Azure when the account name is set', () => {
    expect(
      createStorageService({ AZURE_BLOB_ACCOUNT_NAME: 'acct' } as unknown as NodeJS.ProcessEnv).backend,
    ).toBe('azure-blob');
  });

  it('uses Azurite when only a connection string is set', () => {
    expect(
      createStorageService({ AZURE_STORAGE_CONNECTION_STRING: AZURITE_CONN } as unknown as NodeJS.ProcessEnv)
        .backend,
    ).toBe('azurite');
  });

  it('prefers Azure over Azurite when both are present', () => {
    expect(
      createStorageService({
        AZURE_BLOB_ACCOUNT_NAME: 'acct',
        AZURE_STORAGE_CONNECTION_STRING: AZURITE_CONN,
      } as unknown as NodeJS.ProcessEnv).backend,
    ).toBe('azure-blob');
  });
});

describe('LocalDiskStorageService', () => {
  let dir: string;
  let svc: LocalDiskStorageService;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
    svc = new LocalDiskStorageService();
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('refuses to issue browser upload URLs (fail closed)', async () => {
    await expect(
      svc.issueUploadUrl({ userId: 'u', originalName: 'a.m4a', mimetype: 'audio/mp4', size: 1 }),
    ).rejects.toThrow(/cannot issue browser upload URLs/);
  });

  it('refuses to issue read URLs (fail closed)', async () => {
    await expect(svc.issueReadUrl('uploads/u/a.m4a', 60_000)).rejects.toThrow(
      /cannot issue read URLs/,
    );
  });

  it('reports head for existing and missing files', async () => {
    const file = path.join(dir, 'a.bin');
    await fs.promises.writeFile(file, Buffer.alloc(42));
    await expect(svc.head(file)).resolves.toEqual({ exists: true, size: 42 });
    await expect(svc.head(path.join(dir, 'missing.bin'))).resolves.toEqual({ exists: false, size: 0 });
  });

  it('materializes to a distinct temp file that can be deleted', async () => {
    const file = path.join(dir, 'a.wav');
    await fs.promises.writeFile(file, Buffer.from('hello'));
    const temp = await svc.materializeToTempFile(file);
    expect(temp).not.toBe(file);
    expect(fs.existsSync(temp)).toBe(true);
    expect(fs.existsSync(file)).toBe(true); // original untouched
    await fs.promises.unlink(temp);
  });

  it('delete is a no-op for missing files', async () => {
    await expect(svc.delete(path.join(dir, 'nope.bin'))).resolves.toBeUndefined();
  });
});

describe('withMaterializedAudio', () => {
  afterEach(() => vi.clearAllMocks());

  it('passes a local path straight through without materializing or deleting', async () => {
    const fn = vi.fn(async (p: string) => p);
    const result = await withMaterializedAudio({ path: '/data/uploads/x.m4a', storage: 'local' }, fn);
    expect(result).toBe('/data/uploads/x.m4a');
    expect(fn).toHaveBeenCalledWith('/data/uploads/x.m4a');
    expect(getStorageService).not.toHaveBeenCalled();
  });

  it('materializes a blob to a temp file and deletes it afterward', async () => {
    const tempFile = path.join(os.tmpdir(), `materialize-test-${Date.now()}.bin`);
    await fs.promises.writeFile(tempFile, Buffer.from('x'));
    const materializeToTempFile = vi.fn(async () => tempFile);
    vi.mocked(getStorageService).mockReturnValue({
      backend: 'azure-blob',
      materializeToTempFile,
    } as never);

    const seen = await withMaterializedAudio(
      { path: 'uploads/u/blob.m4a', storage: 'blob' },
      async (p) => {
        expect(fs.existsSync(p)).toBe(true);
        return p;
      },
    );

    expect(seen).toBe(tempFile);
    expect(materializeToTempFile).toHaveBeenCalledWith('uploads/u/blob.m4a');
    expect(fs.existsSync(tempFile)).toBe(false); // cleaned up in finally
  });

  it('deletes the temp file even when fn throws', async () => {
    const tempFile = path.join(os.tmpdir(), `materialize-throw-${Date.now()}.bin`);
    await fs.promises.writeFile(tempFile, Buffer.from('x'));
    vi.mocked(getStorageService).mockReturnValue({
      backend: 'azure-blob',
      materializeToTempFile: vi.fn(async () => tempFile),
    } as never);

    await expect(
      withMaterializedAudio({ path: 'uploads/u/b.m4a', storage: 'blob' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(fs.existsSync(tempFile)).toBe(false);
  });
});
