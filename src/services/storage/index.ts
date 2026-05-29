import { logger } from '@/lib/logger';
import { AzureBlobStorageService } from './azure';
import { AzuriteStorageService } from './azurite';
import { LocalDiskStorageService } from './local';
import type { StorageService } from './types';

/**
 * Pure backend selection — production prefers a real account, then Azurite for
 * local dev / smoke, then disk as a last resort. Exported separately so it can
 * be unit-tested without touching the module-level singleton.
 */
export function createStorageService(env: NodeJS.ProcessEnv = process.env): StorageService {
  if (env.AZURE_BLOB_ACCOUNT_NAME) return new AzureBlobStorageService(env.AZURE_BLOB_ACCOUNT_NAME);
  if (env.AZURE_STORAGE_CONNECTION_STRING) {
    return new AzuriteStorageService(env.AZURE_STORAGE_CONNECTION_STRING);
  }
  return new LocalDiskStorageService();
}

let instance: StorageService | null = null;

export function getStorageService(): StorageService {
  if (!instance) {
    instance = createStorageService();
    logger.info(`[storage] backend=${instance.backend}`);
  }
  return instance;
}

/** Test-only: drop the cached singleton so a new env can be selected. */
export function resetStorageService(): void {
  instance = null;
}

export type { StorageService } from './types';
export {
  buildBlobPath,
  blobPathOwnedBy,
  UPLOAD_URL_TTL_MS,
} from './types';
