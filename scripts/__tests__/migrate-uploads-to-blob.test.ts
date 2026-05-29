import { describe, it, expect, vi } from 'vitest';
import { migrateUploadsToBlob, type MigrationDeps } from '../migrate-uploads-to-blob';

function makeRow(over: Partial<{ id: string; userId: string; filename: string; path: string; size: number }> = {}) {
  return {
    id: over.id ?? 'up_1',
    userId: over.userId ?? 'user_1',
    filename: over.filename ?? '123-uuid.m4a',
    path: over.path ?? '/data/uploads/123-uuid.m4a',
    size: over.size ?? 1000,
  };
}

function makeDeps(rows: ReturnType<typeof makeRow>[], over: Partial<MigrationDeps> = {}): MigrationDeps {
  const sizes = new Map(rows.map((r) => [r.path, r.size]));
  return {
    listLocalUploads: vi.fn(async () => rows),
    markMigrated: vi.fn(async () => {}),
    storage: {
      uploadFile: vi.fn(async () => {}),
      head: vi.fn(async (_blobPath: string) => ({ exists: true, size: rows[0]?.size ?? 0 })),
    },
    fileSize: vi.fn((p: string) => (sizes.has(p) ? (sizes.get(p) as number) : null)),
    unlink: vi.fn(),
    log: vi.fn(),
    ...over,
  };
}

describe('migrateUploadsToBlob', () => {
  it('uploads, verifies, marks migrated, and deletes the local file', async () => {
    const row = makeRow();
    const deps = makeDeps([row]);

    const result = await migrateUploadsToBlob(deps);

    expect(result).toEqual({ migrated: 1, skipped: 0, failed: 0 });
    expect(deps.storage.uploadFile).toHaveBeenCalledWith('uploads/user_1/123-uuid.m4a', row.path);
    expect(deps.markMigrated).toHaveBeenCalledWith('up_1', 'uploads/user_1/123-uuid.m4a');
    expect(deps.unlink).toHaveBeenCalledWith(row.path);
  });

  it('skips rows whose source file is missing without uploading or deleting', async () => {
    const row = makeRow();
    const deps = makeDeps([row], { fileSize: vi.fn(() => null) });

    const result = await migrateUploadsToBlob(deps);

    expect(result).toEqual({ migrated: 0, skipped: 1, failed: 0 });
    expect(deps.storage.uploadFile).not.toHaveBeenCalled();
    expect(deps.markMigrated).not.toHaveBeenCalled();
    expect(deps.unlink).not.toHaveBeenCalled();
  });

  it('fails the row (and keeps the local file) when blob verification mismatches', async () => {
    const row = makeRow({ size: 1000 });
    const deps = makeDeps([row], {
      storage: {
        uploadFile: vi.fn(async () => {}),
        head: vi.fn(async () => ({ exists: true, size: 999 })),
      },
    });

    const result = await migrateUploadsToBlob(deps);

    expect(result).toEqual({ migrated: 0, skipped: 0, failed: 1 });
    expect(deps.markMigrated).not.toHaveBeenCalled();
    expect(deps.unlink).not.toHaveBeenCalled();
  });

  it('counts an upload error as a failure without deleting the local file', async () => {
    const row = makeRow();
    const deps = makeDeps([row], {
      storage: {
        uploadFile: vi.fn(async () => {
          throw new Error('network down');
        }),
        head: vi.fn(async () => ({ exists: false, size: 0 })),
      },
    });

    const result = await migrateUploadsToBlob(deps);

    expect(result).toEqual({ migrated: 0, skipped: 0, failed: 1 });
    expect(deps.unlink).not.toHaveBeenCalled();
  });

  it('skips rows whose on-disk size no longer matches the recorded size', async () => {
    const row = makeRow({ size: 1000 });
    // fileSize reports a different size than row.size (corruption/truncation).
    const deps = makeDeps([row], { fileSize: vi.fn(() => 500) });

    const result = await migrateUploadsToBlob(deps);

    expect(result).toEqual({ migrated: 0, skipped: 1, failed: 0 });
    expect(deps.storage.uploadFile).not.toHaveBeenCalled();
    expect(deps.markMigrated).not.toHaveBeenCalled();
    expect(deps.unlink).not.toHaveBeenCalled();
  });

  it('is idempotent: a re-run with no local rows does nothing', async () => {
    const deps = makeDeps([]);

    const result = await migrateUploadsToBlob(deps);

    expect(result).toEqual({ migrated: 0, skipped: 0, failed: 0 });
    expect(deps.storage.uploadFile).not.toHaveBeenCalled();
  });

  it('processes multiple rows, tallying mixed outcomes', async () => {
    const ok = makeRow({ id: 'a', path: '/data/a.m4a', size: 10 });
    const missing = makeRow({ id: 'b', path: '/data/b.m4a', size: 20 });
    const sizes = new Map([[ok.path, ok.size]]); // missing not present

    const deps = makeDeps([ok, missing], {
      fileSize: vi.fn((p: string) => (sizes.has(p) ? (sizes.get(p) as number) : null)),
      storage: {
        uploadFile: vi.fn(async () => {}),
        head: vi.fn(async () => ({ exists: true, size: 10 })),
      },
    });

    const result = await migrateUploadsToBlob(deps);

    expect(result).toEqual({ migrated: 1, skipped: 1, failed: 0 });
  });
});
