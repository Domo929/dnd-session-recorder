import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/retention';
import { purgeExpiredAudio } from '@/services/retention';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * POST /api/cron/audio-retention
 *
 * Scheduled daily (~03:00 UTC by the external scheduler in the deploy repo).
 * Deletes session-audio blobs past `Upload.audioExpiresAt`. Protected by the
 * `Authorization: Bearer <CRON_SECRET>` header; fails closed if unset.
 */
export async function POST(request: NextRequest) {
  if (!isCronAuthorized(request.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await purgeExpiredAudio();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logger.error('Audio retention cron failed', error as Error);
    return NextResponse.json({ error: 'Audio retention failed' }, { status: 500 });
  }
}
