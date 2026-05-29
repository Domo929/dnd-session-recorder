#!/usr/bin/env tsx
/**
 * Migrate existing local-disk uploads to Azure Blob Storage.
 *
 * Walks every `Upload` row still on `storage='local'`, streams its on-disk file
 * up to the blob container, verifies the upload, flips the row to `storage='blob'`
 * (with the new blob path), and deletes the local file.
 *
 * Safety properties:
 * - Refuses to run unless `AZURE_BLOB_ACCOUNT_NAME` is set, so prod data can never
 *   be migrated into a throwaway Azurite/dev backend (data-loss footgun).
 * - Serial (no concurrency) to keep RAM flat on a small App Service plan.
 * - Idempotent: only touches rows still `'local'`, so it re-runs cleanly after an
 *   interruption. Missing source files are skipped (orphan DB rows), not failed.
 *
 * Triggered manually post-deploy (never on boot):
 *   docker exec <container> node /app/scripts/migrate-uploads-to-blob.js
 */

import fs from 'fs';
import { buildBlobPath } from '../src/services/storage/types';

export interface MigrationResult {
  migrated: number;
  skipped: number;
  failed: number;
}

interface UploadRow {
  id: string;
  userId: string;
  filename: string;
  path: string;
  size: number;
}

export interface MigrationDeps {
  /** Return all uploads still backed by local disk. */
  listLocalUploads(): Promise<UploadRow[]>;
  /** Persist the row's move to blob storage. */
  markMigrated(id: string, blobPath: string): Promise<void>;
  storage: {
    uploadFile(blobPath: string, localPath: string): Promise<void>;
    head(blobPath: string): Promise<{ exists: boolean; size: number }>;
  };
  fileSize(localPath: string): number | null;
  unlink(localPath: string): void;
  log(message: string): void;
}

/**
 * Core migration loop, dependency-injected so it can be unit-tested without a
 * live database, real blob storage, or the filesystem.
 */
export async function migrateUploadsToBlob(deps: MigrationDeps): Promise<MigrationResult> {
  const rows = await deps.listLocalUploads();
  deps.log(`Found ${rows.length} local upload(s) to migrate`);

  const result: MigrationResult = { migrated: 0, skipped: 0, failed: 0 };

  for (const row of rows) {
    const localSize = deps.fileSize(row.path);
    if (localSize === null) {
      deps.log(`SKIP ${row.id}: source file missing (${row.path})`);
      result.skipped += 1;
      continue;
    }

    // filename already carries the `{timestamp}-{uuid}` convention — no rename.
    const blobPath = buildBlobPath(row.userId, row.filename);

    try {
      await deps.storage.uploadFile(blobPath, row.path);

      const head = await deps.storage.head(blobPath);
      if (!head.exists || head.size !== localSize) {
        throw new Error(
          `blob verification failed (exists=${head.exists}, size=${head.size}, expected=${localSize})`,
        );
      }

      await deps.markMigrated(row.id, blobPath);
      deps.unlink(row.path);

      deps.log(`OK   ${row.id}: ${row.path} -> ${blobPath}`);
      result.migrated += 1;
    } catch (err) {
      deps.log(`FAIL ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      result.failed += 1;
    }
  }

  deps.log(
    `Done. Migrated ${result.migrated}, skipped ${result.skipped} (missing), failed ${result.failed}.`,
  );
  return result;
}

async function main(): Promise<void> {
  if (!process.env.AZURE_BLOB_ACCOUNT_NAME) {
    console.error(
      '[migrate-uploads] ERROR: AZURE_BLOB_ACCOUNT_NAME is not set. Refusing to run: ' +
        'this script must only migrate into a real storage account, never Azurite/dev.',
    );
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-uploads] ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  const { prisma } = await import('../src/lib/prisma');
  const { getStorageService } = await import('../src/services/storage');
  const storage = getStorageService();

  const result = await migrateUploadsToBlob({
    listLocalUploads: () =>
      prisma.upload.findMany({
        where: { storage: 'local' },
        select: { id: true, userId: true, filename: true, path: true, size: true },
      }),
    markMigrated: async (id, blobPath) => {
      await prisma.upload.update({
        where: { id },
        data: { path: blobPath, storage: 'blob' },
      });
    },
    storage,
    fileSize: (localPath) => {
      try {
        return fs.statSync(localPath).size;
      } catch {
        return null;
      }
    },
    unlink: (localPath) => {
      fs.unlinkSync(localPath);
    },
    log: (message) => console.log(`[migrate-uploads] ${message}`),
  });

  await prisma.$disconnect();
  process.exit(result.failed > 0 ? 1 : 0);
}

// Only run when invoked directly (not when imported by a test).
if (process.argv[1] && process.argv[1].includes('migrate-uploads-to-blob')) {
  main().catch((err) => {
    console.error(`[migrate-uploads] Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
