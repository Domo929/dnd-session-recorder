import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-utils';
import { getStorageService } from '@/services/storage';
import { isAllowedMime, maxFileSize } from '@/services/storage/uploadValidation';
import { logger } from '@/lib/logger';

interface SasRequest {
  originalName?: string;
  mimetype?: string;
  size?: number;
}

/**
 * POST /api/uploads/sas
 *
 * Issues a single-blob, create+write, 30-minute upload URL the browser PUTs the
 * audio directly to. The app never sees the bytes.
 */
export async function POST(request: NextRequest) {
  try {
    const { error: authError, user } = await requireAuth();
    if (authError) return authError;

    const body = (await request.json().catch(() => ({}))) as SasRequest;
    const { originalName, mimetype, size } = body;

    if (!originalName || !mimetype || typeof size !== 'number') {
      return NextResponse.json(
        { error: 'Missing required fields: originalName, mimetype, size' },
        { status: 400 },
      );
    }

    if (!isAllowedMime(mimetype)) {
      return NextResponse.json(
        { error: 'Invalid file type. Only audio files are allowed.' },
        { status: 400 },
      );
    }

    if (size > maxFileSize()) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${Math.floor(maxFileSize() / 1_000_000)}MB` },
        { status: 413 },
      );
    }

    try {
      const { uploadUrl, blobPath, expiresAt } = await getStorageService().issueUploadUrl({
        userId: user.id,
        originalName,
        mimetype,
        size,
      });

      return NextResponse.json({ sasUrl: uploadUrl, blobPath, expiresAt: expiresAt.toISOString() });
    } catch (err) {
      logger.error('Failed to issue upload URL', err as Error, { userId: user.id });
      return NextResponse.json(
        { error: 'Storage temporarily unavailable. Please try again shortly.' },
        { status: 503 },
      );
    }
  } catch (error) {
    logger.error('SAS issue error', error as Error);
    return NextResponse.json({ error: 'Failed to issue upload URL' }, { status: 500 });
  }
}
