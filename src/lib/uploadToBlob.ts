'use client';

import { BlockBlobClient, AnonymousCredential } from '@azure/storage-blob';

export interface UploadedBlob {
  blobPath: string;
  originalName: string;
  mimetype: string;
  size: number;
}

interface SasResponse {
  sasUrl: string;
  blobPath: string;
  expiresAt: string;
}

/**
 * Three-step direct-to-blob upload used by every browser upload form:
 *   1. ask the app for a short-lived SAS URL (`POST /api/uploads/sas`),
 *   2. PUT the file straight to Azure Blob Storage (bypassing the app server,
 *      lifting the size ceiling and keeping app RAM flat), reporting real
 *      progress,
 *   3. return the metadata the caller hands to `create-with-upload` / `uploads`
 *      to create the `Upload` row.
 *
 * `onProgress` receives a 0..1 fraction.
 */
export async function uploadFileToBlob(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<UploadedBlob> {
  const sasResponse = await fetch('/api/uploads/sas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originalName: file.name,
      mimetype: file.type,
      size: file.size,
    }),
  });

  if (!sasResponse.ok) {
    const error = await sasResponse.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to obtain upload URL');
  }

  const { sasUrl, blobPath } = (await sasResponse.json()) as SasResponse;

  const client = new BlockBlobClient(sasUrl, new AnonymousCredential());
  await client.uploadData(file, {
    blockSize: 4 * 1024 * 1024,
    concurrency: 4,
    blobHTTPHeaders: file.type ? { blobContentType: file.type } : undefined,
    onProgress: ({ loadedBytes }) => {
      if (onProgress && file.size > 0) {
        onProgress(Math.min(loadedBytes / file.size, 1));
      }
    },
  });

  return {
    blobPath,
    originalName: file.name,
    mimetype: file.type,
    size: file.size,
  };
}
