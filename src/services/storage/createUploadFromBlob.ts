import { db } from '@/services/database';
import { getAudioDuration } from '@/services/audioProcessing';
import { logger } from '@/lib/logger';
import { getStorageService } from './index';
import { withMaterializedAudio } from './materialize';
import { blobPathOwnedBy } from './types';
import { isAllowedMime } from './uploadValidation';

export class UploadCompletionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'UploadCompletionError';
  }
}

export interface CompleteUploadInput {
  blobPath: string;
  originalName: string;
  mimetype: string;
  size: number;
}

/**
 * Turn a blob the browser already PUT into an `Upload` row. Shared by
 * `/api/uploads/complete`, `create-with-upload`, and `[id]/upload`.
 *
 * Steps (design Section 1):
 *  1. Verify the signed-in user owns `blobPath`.
 *  2. HEAD the blob; read its real size.
 *  3. Reject if the real size differs from the client-supplied size.
 *  4. Materialize → ffprobe duration → drop the temp file.
 *  5. Insert the `Upload` row (storage='blob').
 *
 * On a size mismatch or probe failure the orphan blob is deleted before throwing.
 */
export async function createUploadFromBlob(userId: string, input: CompleteUploadInput) {
  const { blobPath, originalName, mimetype, size } = input;
  const storage = getStorageService();

  if (!isAllowedMime(mimetype)) {
    throw new UploadCompletionError(400, 'Invalid file type. Only audio files are allowed.');
  }

  if (!blobPathOwnedBy(blobPath, userId)) {
    throw new UploadCompletionError(403, 'You do not have access to this upload.');
  }

  const { exists, size: realSize } = await storage.head(blobPath);
  if (!exists) {
    throw new UploadCompletionError(404, 'Uploaded file not found. The upload may have failed.');
  }

  if (realSize !== size) {
    logger.warn('Uploaded size mismatch; deleting orphan blob', { blobPath, userId, realSize, size });
    await storage.delete(blobPath).catch(() => {});
    throw new UploadCompletionError(
      422,
      `Uploaded size (${realSize}) does not match the declared size (${size}).`,
    );
  }

  let duration: number | undefined;
  try {
    duration = await withMaterializedAudio({ path: blobPath, storage: 'blob' }, async (localPath) =>
      Math.round(await getAudioDuration(localPath)),
    );
  } catch (err) {
    logger.error('ffprobe failed for completed upload; deleting orphan blob', err as Error, {
      blobPath,
      userId,
    });
    await storage.delete(blobPath).catch(() => {});
    throw new UploadCompletionError(422, 'Could not read the uploaded audio file.');
  }

  const filename = blobPath.split('/').pop() ?? blobPath;
  const upload = await db.createUpload({
    userId,
    filename,
    originalName,
    path: blobPath,
    size: realSize,
    mimetype,
    duration,
    storage: 'blob',
  });

  logger.info('Upload record created from blob', { uploadId: upload.id, userId, blobPath });
  return upload;
}
