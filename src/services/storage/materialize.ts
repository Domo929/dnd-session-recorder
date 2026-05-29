import fs from 'fs';
import type { UploadStorage } from '@prisma/client';
import { getStorageService } from './index';

/**
 * Run `fn` with a guaranteed-local path to the upload's audio.
 *
 * - `local` rows already live on disk → pass the path straight through (no copy,
 *   and crucially no delete of the real file afterwards).
 * - `blob` rows are downloaded to a unique temp file, which is removed in the
 *   `finally` regardless of how `fn` resolves.
 */
export async function withMaterializedAudio<T>(
  upload: { path: string; storage: UploadStorage },
  fn: (localPath: string) => Promise<T>,
): Promise<T> {
  if (upload.storage === 'local') {
    return fn(upload.path);
  }

  const tempPath = await getStorageService().materializeToTempFile(upload.path);
  try {
    return await fn(tempPath);
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}
