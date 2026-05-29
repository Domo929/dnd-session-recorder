import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  BlobHead,
  IssueUploadOptions,
  IssuedReadUrl,
  IssuedUpload,
  StorageBackend,
  StorageService,
} from './types';

const uploadDir =
  process.env.UPLOAD_DIR ||
  (process.env.NODE_ENV === 'production' ? '/app/data/uploads' : './uploads');

/**
 * Disk-backed fallback. Kept ONLY so unit tests and pre-blob `storage='local'`
 * rows still work; production must use a Blob backend. For local rows `blobPath`
 * is the absolute on-disk path (matching the historical `Upload.path`).
 *
 * It intentionally CANNOT issue browser upload URLs — the browser uploader speaks
 * the Azure block-blob protocol, which a plain disk endpoint cannot serve. We
 * fail closed rather than silently degrade (see design "Failure mode" decision).
 */
export class LocalDiskStorageService implements StorageService {
  readonly backend: StorageBackend = 'local';

  async issueUploadUrl(_opts: IssueUploadOptions): Promise<IssuedUpload> {
    throw new Error(
      'Local storage backend cannot issue browser upload URLs. Configure Azurite ' +
        '(AZURE_STORAGE_CONNECTION_STRING) for local development or a real storage ' +
        'account (AZURE_BLOB_ACCOUNT_NAME) for production.',
    );
  }

  async issueUploadUrlForPath(_blobPath: string): Promise<IssuedUpload> {
    throw new Error(
      'Local storage backend cannot issue browser upload URLs. Configure Azurite ' +
        '(AZURE_STORAGE_CONNECTION_STRING) for local development or a real storage ' +
        'account (AZURE_BLOB_ACCOUNT_NAME) for production.',
    );
  }

  async issueReadUrl(_blobPath: string, _ttlMs: number): Promise<IssuedReadUrl> {
    throw new Error(
      'Local storage backend cannot issue read URLs. Configure a real storage ' +
        'account (AZURE_BLOB_ACCOUNT_NAME) so the diarization container can fetch audio.',
    );
  }

  async uploadFile(_blobPath: string, _localPath: string): Promise<void> {
    throw new Error(
      'Local storage backend cannot upload to blob storage. Configure a real ' +
        'storage account (AZURE_BLOB_ACCOUNT_NAME) to run the migration script.',
    );
  }

  async head(blobPath: string): Promise<BlobHead> {
    try {
      const stat = await fs.promises.stat(blobPath);
      return { exists: true, size: stat.size };
    } catch {
      return { exists: false, size: 0 };
    }
  }

  /** Copies the file to a temp path so the caller can safely delete it. */
  async materializeToTempFile(blobPath: string): Promise<string> {
    const tempPath = path.join(os.tmpdir(), `${randomUUID()}${path.extname(blobPath)}`);
    await fs.promises.copyFile(blobPath, tempPath);
    return tempPath;
  }

  async delete(blobPath: string): Promise<void> {
    await fs.promises.unlink(blobPath).catch(() => {});
  }
}

export { uploadDir as localUploadDir };
