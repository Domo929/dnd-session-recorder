import { NextRequest, NextResponse } from 'next/server';
import { requireCampaignAccess } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';

interface SearchRow {
  sessionId: string;
  sessionTitle: string;
  sourceType: string;
  startTime: number | null;
  speakerLabels: string[];
  snippet: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;

  const access = await requireCampaignAccess(campaignId, 'any');
  if (!access.ok) return access.response;

  const q = (new URL(request.url).searchParams.get('q') ?? '').trim();
  if (!q) return NextResponse.json({ results: [] });

  const rows = await prisma.$queryRaw<SearchRow[]>`
    SELECT cc.session_id     AS "sessionId",
           gs.title          AS "sessionTitle",
           cc.source_type    AS "sourceType",
           cc.start_time     AS "startTime",
           cc.speaker_labels AS "speakerLabels",
           ts_headline('english', cc.text, websearch_to_tsquery('english', ${q}),
                       'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MaxWords=18,MinWords=5') AS snippet
    FROM campaign_chunks cc
    JOIN gaming_sessions gs ON gs.id = cc.session_id
    WHERE cc.campaign_id = ${campaignId}
      AND cc.text_search @@ websearch_to_tsquery('english', ${q})
    ORDER BY ts_rank(cc.text_search, websearch_to_tsquery('english', ${q})) DESC
    LIMIT 30
  `;

  return NextResponse.json({ results: rows });
}
