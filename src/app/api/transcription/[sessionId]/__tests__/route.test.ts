import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/services/database', () => ({ db: {} }));
vi.mock('@/lib/auth-utils', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/permissions', () => ({ requireSessionAccess: vi.fn() }));
vi.mock('@/lib/whitelist', () => ({ isTestAccount: vi.fn(() => false) }));
vi.mock('@/services/storage', () => ({ getStorageService: vi.fn() }));
vi.mock('@/services/storage/materialize', () => ({
  withMaterializedAudio: vi.fn(),
}));
vi.mock('@/services/audioProcessing', () => ({
  splitAudioBySize: vi.fn(),
  cleanupChunkFiles: vi.fn(),
}));
vi.mock('@/services/fileCleanup', () => ({
  fileCleanup: { cleanupSessionFiles: vi.fn(async () => {}) },
}));
vi.mock('@/lib/ai', () => ({
  transcribeWithBackoff: vi.fn(),
  createTranscriptionPacer: vi.fn(() => vi.fn(async () => {})),
  transcriptionMinIntervalMs: vi.fn(() => 0),
  isAiMocked: vi.fn(() => false),
  maxTranscriptionChunkSizeMB: vi.fn(() => 14),
}));
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => Buffer.from('chunk-bytes')),
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from '@/services/database';
import { requireAuth } from '@/lib/auth-utils';
import { requireSessionAccess } from '@/lib/permissions';
import { withMaterializedAudio } from '@/services/storage/materialize';
import { splitAudioBySize } from '@/services/audioProcessing';
import { transcribeWithBackoff } from '@/lib/ai';
import { fileCleanup } from '@/services/fileCleanup';
import { POST } from '../route';

const session = {
  id: 'sess_1',
  status: 'uploaded',
  uploadId: 'upl_1',
  upload: { id: 'upl_1', path: 'uploads/u/x.m4a', storage: 'local' },
};

function makeRequest() {
  const req = new Request('http://localhost/api/transcription/sess_1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }) as unknown as Parameters<typeof POST>[0];
  return { req, ctx: { params: Promise.resolve({ sessionId: 'sess_1' }) } };
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(requireAuth).mockResolvedValue({
    error: undefined,
    user: { email: 'real@example.com' },
  } as never);

  vi.mocked(requireSessionAccess).mockResolvedValue({
    ok: true,
    userId: 'user_1',
    role: 'owner',
    campaignId: 'camp_1',
  } as never);

  // Materialize just invokes the callback with a local path.
  vi.mocked(withMaterializedAudio).mockImplementation(
    async (_upload: unknown, cb: (p: string) => unknown) => cb('/tmp/audio.m4a'),
  );

  // Three chunks by default.
  vi.mocked(splitAudioBySize).mockResolvedValue([
    { path: '/tmp/c0' },
    { path: '/tmp/c1' },
    { path: '/tmp/c2' },
  ] as never);

  Object.assign(db as unknown as Record<string, unknown>, {
    getSessionById: vi.fn(async () => session),
    getCampaignById: vi.fn(async () => null),
    getTranscriptions: vi.fn(async () => []),
    startProcessing: vi.fn(async () => {}),
    updateSession: vi.fn(async () => {}),
    updateTranscriptionProgress: vi.fn(async () => {}),
    updateUploadStatus: vi.fn(async () => {}),
    scheduleAudioExpiry: vi.fn(async () => {}),
    saveTranscription: vi.fn(async () => {}),
    setSessionError: vi.fn(async () => {}),
    getTranscriptionChunkCount: vi.fn(async () => null),
    getTranscriptionChunks: vi.fn(async () => new Map<number, string>()),
    clearTranscriptionChunks: vi.fn(async () => {}),
    setTranscriptionChunkCount: vi.fn(async () => {}),
    upsertTranscriptionChunk: vi.fn(async () => {}),
  });
});

describe('POST /api/transcription/[sessionId] — resumable transcription', () => {
  it('returns the access response and runs nothing when the caller lacks session access', async () => {
    vi.mocked(requireSessionAccess).mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: 'Not found' }, { status: 404 }),
    } as never);

    const { req, ctx } = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);

    // No pipeline work should happen on a denied request.
    expect(db.getTranscriptions).not.toHaveBeenCalled();
    expect(transcribeWithBackoff).not.toHaveBeenCalled();
  });

  it('transcribes every chunk on a fresh run and persists each one', async () => {
    vi.mocked(transcribeWithBackoff).mockImplementation(async () => ({ text: 'X' }));

    const { req, ctx } = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);

    // Fresh run: signature null → clear partial rows + record the new count.
    expect(db.clearTranscriptionChunks).toHaveBeenCalledWith('sess_1');
    expect(db.setTranscriptionChunkCount).toHaveBeenCalledWith('sess_1', 3);

    // All three chunks transcribed + persisted.
    expect(transcribeWithBackoff).toHaveBeenCalledTimes(3);
    expect(db.upsertTranscriptionChunk).toHaveBeenCalledTimes(3);
    expect(db.upsertTranscriptionChunk).toHaveBeenCalledWith('sess_1', 0, 'X');
    expect(db.upsertTranscriptionChunk).toHaveBeenCalledWith('sess_1', 2, 'X');

    // Stitched + chunk rows cleared on success.
    expect(db.saveTranscription).toHaveBeenCalledWith('sess_1', 'X X X');
    expect(db.setTranscriptionChunkCount).toHaveBeenLastCalledWith('sess_1', null);

    // Audio is retained (retention clock started), not deleted, so the on-demand
    // "Identify speakers" diarization can still use it.
    expect(db.updateUploadStatus).toHaveBeenCalledWith('upl_1', 'transcribed', expect.anything());
    expect(db.scheduleAudioExpiry).toHaveBeenCalledWith('upl_1');
    expect(fileCleanup.cleanupSessionFiles).not.toHaveBeenCalled();
  });

  it('resumes: skips persisted chunks and only transcribes the missing one', async () => {
    (db.getTranscriptionChunkCount as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    (db.getTranscriptionChunks as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map<number, string>([
        [0, 'AAA'],
        [1, 'BBB'],
      ]),
    );
    vi.mocked(transcribeWithBackoff).mockResolvedValue({ text: 'CCC' });

    const { req, ctx } = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);

    // Only the missing chunk (index 2) hits the provider.
    expect(transcribeWithBackoff).toHaveBeenCalledTimes(1);
    expect(db.upsertTranscriptionChunk).toHaveBeenCalledTimes(1);
    expect(db.upsertTranscriptionChunk).toHaveBeenCalledWith('sess_1', 2, 'CCC');

    // Stitched in index order from persisted + new text.
    expect(db.saveTranscription).toHaveBeenCalledWith('sess_1', 'AAA BBB CCC');
  });

  it('signature mismatch wipes partial work and restarts from scratch', async () => {    (db.getTranscriptionChunkCount as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    vi.mocked(transcribeWithBackoff).mockResolvedValue({ text: 'Z' });

    const { req, ctx } = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);

    // Mismatch (5 vs 3) → wipe + reset count to the fresh split, never load rows.
    expect(db.clearTranscriptionChunks).toHaveBeenCalledWith('sess_1');
    expect(db.setTranscriptionChunkCount).toHaveBeenCalledWith('sess_1', 3);
    expect(db.getTranscriptionChunks).not.toHaveBeenCalled();
    expect(transcribeWithBackoff).toHaveBeenCalledTimes(3);
  });

  it('leaves persisted chunks in place when a chunk ultimately fails', async () => {
    vi.mocked(transcribeWithBackoff)
      .mockResolvedValueOnce({ text: 'ok0' })
      .mockRejectedValueOnce(new Error('429 quota exhausted'));

    const { req, ctx } = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(500);

    // The one successful chunk was persisted; the final stitch/clear never ran.
    expect(db.upsertTranscriptionChunk).toHaveBeenCalledWith('sess_1', 0, 'ok0');
    expect(db.saveTranscription).not.toHaveBeenCalled();
    expect(db.setSessionError).toHaveBeenCalled();
  });
});
