import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requireCampaignAccess } from '@/lib/permissions';
import { getStorageService } from '@/services/storage';
import { buildVoiceSamplePath } from '@/services/storage/voicePaths';
import { isAllowedMime, maxFileSize } from '@/services/storage/uploadValidation';
import { logger } from '@/lib/logger';

interface VoiceSasRequest {
  mimetype?: string;
  size?: number;
}

/**
 * POST /api/campaigns/[id]/voice-samples/sas
 *
 * Issues a single-blob, create+write upload URL for a voice-enrollment clip.
 * The browser PUTs the recording straight to Blob; the app finalizes (and
 * embeds) it via POST /api/campaigns/[id]/voice-samples.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await requireCampaignAccess(id, 'any');
  if (!access.ok) return access.response;

  const body = (await request.json().catch(() => ({}))) as VoiceSasRequest;
  const { mimetype, size } = body;

  if (!mimetype || typeof size !== 'number') {
    return NextResponse.json(
      { error: 'Missing required fields: mimetype, size' },
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

  const blobPath = buildVoiceSamplePath(access.userId, randomUUID());

  try {
    const { uploadUrl, expiresAt } = await getStorageService().issueUploadUrlForPath(blobPath);
    return NextResponse.json({ sasUrl: uploadUrl, blobPath, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    logger.error('Failed to issue voice upload URL', err as Error, { userId: access.userId });
    return NextResponse.json(
      { error: 'Storage temporarily unavailable. Please try again shortly.' },
      { status: 503 },
    );
  }
}
