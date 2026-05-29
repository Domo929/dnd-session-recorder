import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import { requireCampaignAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { getStorageService } from '@/services/storage';
import { logger } from '@/lib/logger';

/**
 * GET /api/clusters/[clusterId]/snippet
 *
 * Streams the 10s review snippet for an unidentified speaker cluster so the DM
 * can listen before tagging it. Proxied through the app (snippets are tiny) to
 * keep the blob namespace private. Any campaign member may listen.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ clusterId: string }> },
) {
  const { clusterId } = await params;

  const cluster = await db.getClusterForTagging(clusterId);
  if (!cluster) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const access = await requireCampaignAccess(cluster.session.campaignId, 'any');
  if (!access.ok) return access.response;

  if (
    !cluster.snippetBlobPath ||
    (cluster.snippetExpiresAt && cluster.snippetExpiresAt.getTime() <= Date.now())
  ) {
    return NextResponse.json({ error: 'Snippet not available' }, { status: 404 });
  }

  let tempPath: string | null = null;
  try {
    tempPath = await getStorageService().materializeToTempFile(cluster.snippetBlobPath);
    const audio = await fs.promises.readFile(tempPath);
    return new NextResponse(new Uint8Array(audio), {
      status: 200,
      headers: {
        'Content-Type': 'audio/ogg',
        'Content-Length': String(audio.length),
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err) {
    logger.error('Failed to stream cluster snippet', err as Error, { clusterId });
    return NextResponse.json({ error: 'Failed to load snippet' }, { status: 500 });
  } finally {
    if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
  }
}
