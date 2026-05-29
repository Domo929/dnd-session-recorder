import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { requireAuth } from '@/lib/auth-utils';
import { db } from '@/services/database';
import { getStorageService } from '@/services/storage';
import { createUploadFromBlob, UploadCompletionError } from '@/services/storage/createUploadFromBlob';
import { logger } from '@/lib/logger';

interface CompleteRequest {
  blobPath?: string;
  originalName?: string;
  mimetype?: string;
  size?: number;
}

/**
 * POST /api/uploads
 *
 * Standalone upload completion. The browser PUTs audio to Blob via a SAS URL
 * (see POST /api/uploads/sas), then calls this with the landed `blobPath` to
 * mint the Upload row. (This replaces the legacy multipart body — bytes no
 * longer pass through the app server.) Equivalent to POST /api/uploads/complete.
 */
export async function POST(request: NextRequest) {
  try {
    const { error: authError, user } = await requireAuth();
    if (authError) return authError;

    const body = (await request.json().catch(() => ({}))) as CompleteRequest;
    const { blobPath, originalName, mimetype, size } = body;

    if (!blobPath || !originalName || !mimetype || typeof size !== 'number') {
      return NextResponse.json(
        { error: 'Missing required fields: blobPath, originalName, mimetype, size' },
        { status: 400 },
      );
    }

    const upload = await createUploadFromBlob(user.id, { blobPath, originalName, mimetype, size });

    return NextResponse.json({
      message: 'File uploaded successfully',
      upload: {
        id: upload.id,
        filename: upload.filename,
        originalName: upload.originalName,
        size: upload.size,
        mimetype: upload.mimetype,
        duration: upload.duration,
        status: upload.status,
        createdAt: upload.createdAt,
      },
    });
  } catch (error) {
    if (error instanceof UploadCompletionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Upload error', error as Error);
    return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
  }
}

/** True when the upload's backing file/blob still exists. */
async function uploadExists(upload: { path: string; storage: string }): Promise<boolean> {
  if (upload.storage === 'blob') {
    try {
      return (await getStorageService().head(upload.path)).exists;
    } catch (err) {
      // On a transient storage error, assume it exists rather than deleting a valid row.
      logger.warn('head() failed during upload reconciliation; keeping row', {
        path: upload.path,
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }
  return fs.existsSync(upload.path);
}

// GET /api/uploads - Get user's uploads (with storage-aware reconciliation)
export async function GET(request: NextRequest) {
  try {
    const { error: authError, user } = await requireAuth();
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const includeSessions = searchParams.get('includeSessions') === 'true';

    const uploads = await db.getUploads(user.id, includeSessions);

    // Reconciliation: drop rows whose backing file/blob no longer exists.
    const validUploads = [];
    const invalidUploadIds = [];
    for (const upload of uploads) {
      if (await uploadExists(upload)) {
        validUploads.push(upload);
      } else {
        logger.warn('File not found for upload', { uploadId: upload.id, path: upload.path });
        invalidUploadIds.push(upload.id);
      }
    }

    if (invalidUploadIds.length > 0) {
      logger.info('Cleaning up upload records with missing files', { count: invalidUploadIds.length });
      try {
        for (const uploadId of invalidUploadIds) {
          await db.deleteUpload(uploadId);
        }
      } catch (cleanupError) {
        logger.error('Failed to clean up invalid uploads', cleanupError as Error);
      }
    }

    return NextResponse.json({
      uploads: validUploads.map((upload) => ({
        id: upload.id,
        filename: upload.filename,
        originalName: upload.originalName,
        size: upload.size,
        mimetype: upload.mimetype,
        duration: upload.duration,
        status: upload.status,
        createdAt: upload.createdAt,
        updatedAt: upload.updatedAt,
      })),
      reconciledCount: invalidUploadIds.length,
    });
  } catch (error) {
    logger.error('Failed to get uploads', error as Error);
    return NextResponse.json({ error: 'Failed to get uploads' }, { status: 500 });
  }
}
