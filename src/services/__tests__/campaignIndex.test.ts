import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/ai', () => ({
  embedTexts: vi.fn(async (t: string[]) => t.map(() => new Array(768).fill(0.1))),
}));

const tx = {
  $executeRaw: vi.fn(),
  campaignChunk: { deleteMany: vi.fn(), createMany: vi.fn() },
};
vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    gamingSession: { findUnique: vi.fn() },
    transcription: { findMany: vi.fn() },
    summary: { findUnique: vi.fn() },
    dmTodoList: { findUnique: vi.fn() },
  },
}));

import { prisma } from '@/lib/prisma';
import { reindexSession } from '@/services/campaignIndex';

type MockWithResolvedValue<T> = { mockResolvedValue(value: T): void };

function mockResolvedValue<T>(fn: unknown, value: T): void {
  (fn as MockWithResolvedValue<T>).mockResolvedValue(value);
}

beforeEach(() => vi.clearAllMocks());

describe('reindexSession', () => {
  it('deletes old chunks, inserts new chunks, and sets embeddings', async () => {
    mockResolvedValue(prisma.gamingSession.findUnique, { id: 's1', campaignId: 'c1' });
    mockResolvedValue(prisma.transcription.findMany, [
      { text: 'hello there', startTime: 0, endTime: 2, speakerCluster: { displayLabel: 'Thalia' } },
    ]);
    mockResolvedValue(prisma.summary.findUnique, { summaryText: 'a summary' });
    mockResolvedValue(prisma.dmTodoList.findUnique, null);

    await reindexSession('s1');

    expect(tx.campaignChunk.deleteMany).toHaveBeenCalledWith({ where: { sessionId: 's1' } });
    expect(tx.campaignChunk.createMany).toHaveBeenCalledTimes(1);
    // 1 transcript chunk + 1 summary chunk = 2 rows
    const createArg = vi.mocked(tx.campaignChunk.createMany).mock.calls[0][0];
    expect(createArg.data).toHaveLength(2);
    expect(createArg.data[0].campaignId).toBe('c1');
    expect(createArg.data[0].sessionId).toBe('s1');
    // one embedding UPDATE per row
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('no-ops when the session does not exist', async () => {
    mockResolvedValue(prisma.gamingSession.findUnique, null);
    await reindexSession('missing');
    expect(tx.campaignChunk.deleteMany).not.toHaveBeenCalled();
  });

  it('still clears chunks when there is no content to index', async () => {
    mockResolvedValue(prisma.gamingSession.findUnique, { id: 's2', campaignId: 'c1' });
    mockResolvedValue(prisma.transcription.findMany, []);
    mockResolvedValue(prisma.summary.findUnique, null);
    mockResolvedValue(prisma.dmTodoList.findUnique, null);

    await reindexSession('s2');

    expect(tx.campaignChunk.deleteMany).toHaveBeenCalledWith({ where: { sessionId: 's2' } });
    expect(tx.campaignChunk.createMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
