import { randomUUID } from 'crypto';
import { prisma } from '@/lib/prisma';
import { embedTexts } from '@/lib/ai';
import { buildTranscriptChunks, type Segment } from '@/lib/chunking';
import { logger } from '@/lib/logger';

type SourceType = 'transcript' | 'summary' | 'dm_todo';

interface PendingChunk {
  id: string;
  sourceType: SourceType;
  chunkIndex: number;
  startTime: number | null;
  endTime: number | null;
  speakerLabels: string[];
  text: string;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Rebuild the campaign_chunks rows for a single gaming session. Idempotent:
 * deletes the session's existing chunks and reinserts freshly chunked +
 * embedded content (transcript windows, summary, DM TODO). Best-effort callers
 * should wrap this in try/catch — it is not safe to assume it never throws.
 */
export async function reindexSession(sessionId: string): Promise<void> {
  const session = await prisma.gamingSession.findUnique({
    where: { id: sessionId },
    select: { id: true, campaignId: true },
  });
  if (!session) return;

  const transcriptions = await prisma.transcription.findMany({
    where: { sessionId },
    orderBy: { startTime: 'asc' },
    select: {
      text: true,
      startTime: true,
      endTime: true,
      speakerCluster: { select: { displayLabel: true } },
    },
  });
  const segments: Segment[] = transcriptions.map((t) => ({
    text: t.text,
    startTime: t.startTime,
    endTime: t.endTime,
    speakerLabel: t.speakerCluster?.displayLabel ?? null,
  }));

  const pending: PendingChunk[] = buildTranscriptChunks(segments).map((c) => ({
    id: randomUUID(),
    sourceType: 'transcript' as const,
    chunkIndex: c.chunkIndex,
    startTime: c.startTime,
    endTime: c.endTime,
    speakerLabels: c.speakerLabels,
    text: c.text,
  }));

  const summary = await prisma.summary.findUnique({
    where: { sessionId },
    select: { summaryText: true },
  });
  if (summary?.summaryText) {
    pending.push({
      id: randomUUID(),
      sourceType: 'summary',
      chunkIndex: pending.length,
      startTime: null,
      endTime: null,
      speakerLabels: [],
      text: summary.summaryText,
    });
  }

  const todo = await prisma.dmTodoList.findUnique({
    where: { sessionId },
    select: { content: true },
  });
  if (todo?.content) {
    pending.push({
      id: randomUUID(),
      sourceType: 'dm_todo',
      chunkIndex: pending.length,
      startTime: null,
      endTime: null,
      speakerLabels: [],
      text: todo.content,
    });
  }

  const embeddings =
    pending.length > 0 ? await embedTexts(pending.map((p) => p.text)) : [];

  await prisma.$transaction(async (tx) => {
    await tx.campaignChunk.deleteMany({ where: { sessionId } });
    if (pending.length === 0) return;

    await tx.campaignChunk.createMany({
      data: pending.map((p) => ({
        id: p.id,
        campaignId: session.campaignId,
        sessionId,
        sourceType: p.sourceType,
        chunkIndex: p.chunkIndex,
        startTime: p.startTime,
        endTime: p.endTime,
        speakerLabels: p.speakerLabels,
        text: p.text,
      })),
    });

    for (let i = 0; i < pending.length; i++) {
      const vec = toVectorLiteral(embeddings[i]);
      await tx.$executeRaw`UPDATE campaign_chunks SET embedding = ${vec}::vector WHERE id = ${pending[i].id}`;
    }
  });

  logger.info('Reindexed session chunks', { sessionId, chunks: pending.length });
}
