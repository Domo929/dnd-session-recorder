import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/retention';
import { purgeExpiredSnippets } from '@/services/retention';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * POST /api/cron/snippet-purge
 *
 * Scheduled daily (~03:15 UTC by the external scheduler in the deploy repo).
 * Deletes unknown-cluster review snippets past `snippetExpiresAt` (cluster rows
 * are kept). Protected by `Authorization: Bearer <CRON_SECRET>`; fails closed.
 */
export async function POST(request: NextRequest) {
  if (!isCronAuthorized(request.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await purgeExpiredSnippets();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logger.error('Snippet purge cron failed', error as Error);
    return NextResponse.json({ error: 'Snippet purge failed' }, { status: 500 });
  }
}
