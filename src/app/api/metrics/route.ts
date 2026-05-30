import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
import { metrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';

// prom-client relies on Node APIs (process, perf_hooks); never run on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Constant-time bearer comparison. Hashing both sides to a fixed-length digest
 * avoids both the early-exit timing leak of `!==` and the length leak / throw
 * of comparing raw buffers of differing length.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Prometheus scrape endpoint. Protected by a bearer token (`METRICS_TOKEN`) so
 * it isn't world-readable — the public route protection in `middleware.ts`
 * deliberately excludes this path, since Prometheus has no NextAuth session.
 *
 * When `METRICS_TOKEN` is unset the endpoint is disabled (404) to fail closed.
 */
export async function GET(request: NextRequest) {
  const token = process.env.METRICS_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const auth = request.headers.get('authorization');
  const provided = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
  if (!provided || !tokenMatches(provided, token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await metrics.registry.metrics();
    return new NextResponse(body, {
      status: 200,
      headers: { 'Content-Type': metrics.registry.contentType },
    });
  } catch (error) {
    logger.error('Failed to render metrics', error as Error);
    return NextResponse.json({ error: 'Failed to render metrics' }, { status: 500 });
  }
}
