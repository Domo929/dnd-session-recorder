import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-utils';
import { createUploadFromBlob, UploadCompletionError } from '@/services/storage/createUploadFromBlob';
import { logger } from '@/lib/logger';

interface CompleteRequest {
  blobPath?: string;
  originalName?: string;
  mimetype?: string;
  size?: number;
}

/**
 * POST /api/uploads/complete
 *
 * Turns a blob the browser already PUT into an `Upload` row (standalone-upload
 * counterpart to the legacy multipart `POST /api/uploads`).
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
      message: 'Upload completed successfully',
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
    logger.error('Upload completion error', error as Error);
    return NextResponse.json({ error: 'Failed to complete upload' }, { status: 500 });
  }
}
