# Campaign AI Chat + Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add campaign-wide keyword search and a multi-turn RAG chat (Gemini) over all transcripts/summaries/DM-TODOs, available to every campaign member.

**Architecture:** A new `CampaignChunk` table stores chunked content + a 768-dim pgvector embedding + a Postgres `tsvector`. Content is chunked by a pure module, embedded via Gemini through `src/lib/ai.ts`, and indexed incrementally (end of the summary route) and via an owner-only backfill route. Keyword search uses Postgres FTS; chat embeds the question, runs pgvector KNN scoped to the campaign, and streams a cited answer from `gemini-2.5-flash`.

**Tech Stack:** Next.js 15 App Router, Prisma 6 (+ `postgresqlExtensions` preview, pgvector), Vercel AI SDK 5 (`@ai-sdk/google`), Vitest, Playwright + testcontainers, React Query / `useChat`.

**Design doc:** `docs/plans/2026-05-30-campaign-ai-chat-design.md`

**Naming note:** A `TranscriptionChunk` / `transcription_chunks` table already exists (resumable transcription — unrelated). This feature's table is `CampaignChunk` / `campaign_chunks`. Do not conflate them.

---

## Conventions to follow (read first)

- **All AI calls live in `src/lib/ai.ts`.** Never call `@ai-sdk/*` from a route (LESSONS.md). Add `embedTexts()` and `streamCampaignChat()` there with a `MOCK_AI_SERVICES` branch.
- **Mock mode:** `isAiMocked()` returns true when `process.env.MOCK_AI_SERVICES === 'true'` (exact string). Mocked AI = no spend, so the `isTestAccount` cost guard must be bypassed when mocked: `if (isTestAccount(email) && !isAiMocked())`.
- **Access:** use `requireCampaignAccess(campaignId, 'any')` (owners + players) from `src/lib/permissions.ts`. Return 404 (not 403) for missing membership.
- **Vitest = `src/**/__tests__/**/*.test.ts`.** Playwright = `*.spec.ts`. Don't cross them.
- **Never commit `.js`/`.d.ts` next to `.ts` in `src/`** (`.gitignore` enforces it).
- **`npm run typecheck` after touching any test file** — `tsc --noEmit` includes tests.
- Commands: `npm run test:unit` (vitest), `npm run typecheck`, `npm run lint`, `npm run db:migrate`.
- After editing `prisma/schema.prisma`, run `npm run db:generate` before typechecking code that uses the new model.

---

## Task 1: Enable pgvector in Prisma + create the `CampaignChunk` model

**Files:**
- Modify: `prisma/schema.prisma` (generator, datasource, new model, two back-relations)

**Step 1: Edit the generator and datasource blocks**

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector]
}
```

**Step 2: Add the model at the end of the file**

```prisma
model CampaignChunk {
  id            String   @id @default(cuid())
  campaignId    String   @map("campaign_id")
  sessionId     String   @map("session_id")
  sourceType    String   @map("source_type") // transcript | summary | dm_todo
  chunkIndex    Int      @map("chunk_index")
  startTime     Float?   @map("start_time")
  endTime       Float?   @map("end_time")
  speakerLabels String[] @map("speaker_labels")
  text          String   @db.Text
  embedding     Unsupported("vector(768)")?
  createdAt     DateTime @default(now()) @map("created_at")

  campaign Campaign      @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  session  GamingSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([campaignId])
  @@index([sessionId])
  @@map("campaign_chunks")
}
```

**Step 3: Add back-relations**

On `model Campaign` add: `campaignChunks CampaignChunk[]`
On `model GamingSession` add: `campaignChunks CampaignChunk[]`

**Step 4: Generate the client**

Run: `npm run db:generate`
Expected: succeeds; `CampaignChunk` available on the Prisma client.

**Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(db): add CampaignChunk model + enable pgvector"
```

---

## Task 2: Create the migration (extension, vector index, FTS column)

**Files:**
- Create: `prisma/migrations/<timestamp>_add_campaign_chunks/migration.sql`

**Step 1: Generate the base migration without applying**

Run: `npx prisma migrate dev --name add_campaign_chunks --create-only`
Expected: a new migration dir with `CREATE TABLE "campaign_chunks" ...`. The
`embedding` column will be `vector(768)`.

**Step 2: Prepend the extension and append indexes** to the generated `migration.sql`

At the very top:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

After the `CREATE TABLE`, add:

```sql
-- Cosine KNN index for RAG retrieval
CREATE INDEX campaign_chunks_embedding_idx
  ON campaign_chunks USING hnsw (embedding vector_cosine_ops);

-- Full-text search column + index (Part A keyword search)
ALTER TABLE campaign_chunks
  ADD COLUMN text_search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;

CREATE INDEX campaign_chunks_text_search_idx
  ON campaign_chunks USING gin (text_search);
```

**Step 3: Apply the migration locally**

Run: `npm run db:migrate`
Expected: applies cleanly against the local docker Postgres.

> If `CREATE EXTENSION` fails locally, the docker Postgres image lacks pgvector.
> Switch `docker-compose.yml` Postgres image to `pgvector/pgvector:pg16` and
> `npm run db:reset`. Note this for the CI testcontainers image too (Task 9).

**Step 4: Commit**

```bash
git add prisma/migrations
git commit -m "feat(db): migration for campaign_chunks (pgvector + FTS)"
```

---

## Task 3: Pure chunking module (`src/lib/chunking.ts`)

**Files:**
- Create: `src/lib/chunking.ts`
- Test: `src/lib/__tests__/chunking.test.ts`

**Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { buildTranscriptChunks, type Segment } from '@/lib/chunking';

const seg = (text: string, start: number, end: number, speaker?: string): Segment =>
  ({ text, startTime: start, endTime: end, speakerLabel: speaker ?? null });

describe('buildTranscriptChunks', () => {
  it('merges short segments into one window with combined timing', () => {
    const chunks = buildTranscriptChunks([seg('a', 0, 1, 'Thalia'), seg('b', 1, 2, 'Thalia')], { maxChars: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startTime).toBe(0);
    expect(chunks[0].endTime).toBe(2);
    expect(chunks[0].text).toBe('a b');
    expect(chunks[0].speakerLabels).toEqual(['Thalia']);
  });

  it('collects the distinct, order-preserved set of speakers', () => {
    const chunks = buildTranscriptChunks(
      [seg('a', 0, 1, 'Thalia'), seg('b', 1, 2, 'Bren'), seg('c', 2, 3, 'Thalia')],
      { maxChars: 100 },
    );
    expect(chunks[0].speakerLabels).toEqual(['Thalia', 'Bren']);
  });

  it('splits into multiple windows when maxChars is exceeded', () => {
    const chunks = buildTranscriptChunks([seg('aaaa', 0, 1), seg('bbbb', 1, 2)], { maxChars: 5 });
    expect(chunks.length).toBe(2);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[1].chunkIndex).toBe(1);
  });

  it('ignores null speakers in the set', () => {
    const chunks = buildTranscriptChunks([seg('a', 0, 1), seg('b', 1, 2, 'Bren')], { maxChars: 100 });
    expect(chunks[0].speakerLabels).toEqual(['Bren']);
  });
});
```

**Step 2: Run to verify failure**

Run: `npm run test:unit -- chunking`
Expected: FAIL (module not found).

**Step 3: Implement `src/lib/chunking.ts`**

```ts
export interface Segment {
  text: string;
  startTime: number;
  endTime: number;
  speakerLabel: string | null;
}

export interface BuiltChunk {
  chunkIndex: number;
  startTime: number | null;
  endTime: number | null;
  speakerLabels: string[];
  text: string;
}

const DEFAULT_MAX_CHARS = 3000; // ~600-800 tokens

export function buildTranscriptChunks(
  segments: Segment[],
  opts: { maxChars?: number } = {},
): BuiltChunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const chunks: BuiltChunk[] = [];
  let buf: Segment[] = [];
  let len = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const speakers: string[] = [];
    for (const s of buf) {
      if (s.speakerLabel && !speakers.includes(s.speakerLabel)) speakers.push(s.speakerLabel);
    }
    chunks.push({
      chunkIndex: chunks.length,
      startTime: buf[0].startTime,
      endTime: buf[buf.length - 1].endTime,
      speakerLabels: speakers,
      text: buf.map((s) => s.text).join(' '),
    });
    buf = [];
    len = 0;
  };

  for (const s of segments) {
    if (len > 0 && len + s.text.length + 1 > maxChars) flush();
    buf.push(s);
    len += s.text.length + 1;
  }
  flush();
  return chunks;
}
```

**Step 4: Run to verify pass**

Run: `npm run test:unit -- chunking` → PASS
Run: `npm run typecheck` → PASS

**Step 5: Commit**

```bash
git add src/lib/chunking.ts src/lib/__tests__/chunking.test.ts
git commit -m "feat: pure transcript chunking module"
```

---

## Task 4: Citation formatting helper (`src/lib/citation.ts`)

**Files:**
- Create: `src/lib/citation.ts`
- Test: `src/lib/__tests__/citation.test.ts`

**Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { formatTimestamp, formatCitation } from '@/lib/citation';

describe('formatTimestamp', () => {
  it('formats seconds as H:MM:SS', () => {
    expect(formatTimestamp(3735)).toBe('1:02:15');
    expect(formatTimestamp(75)).toBe('0:01:15');
  });
});

describe('formatCitation', () => {
  const base = { sessionTitle: 'The Crypt', startTime: 3735 };
  it('single speaker', () => {
    expect(formatCitation({ ...base, sourceType: 'transcript', speakerLabels: ['Thalia'] }))
      .toBe('[Session "The Crypt" @ 1:02:15, Thalia]');
  });
  it('multiple speakers', () => {
    expect(formatCitation({ ...base, sourceType: 'transcript', speakerLabels: ['Thalia', 'Bren'] }))
      .toBe('[Session "The Crypt" @ 1:02:15, speakers: Thalia, Bren]');
  });
  it('summary chunk', () => {
    expect(formatCitation({ sessionTitle: 'The Crypt', sourceType: 'summary', speakerLabels: [], startTime: null }))
      .toBe('[Session "The Crypt" — summary]');
  });
});
```

**Step 2:** Run `npm run test:unit -- citation` → FAIL.

**Step 3: Implement**

```ts
export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export interface CitationInput {
  sessionTitle: string;
  sourceType: string; // transcript | summary | dm_todo
  speakerLabels: string[];
  startTime: number | null;
}

export function formatCitation(c: CitationInput): string {
  if (c.sourceType !== 'transcript') {
    const label = c.sourceType === 'dm_todo' ? 'DM TODO' : 'summary';
    return `[Session "${c.sessionTitle}" — ${label}]`;
  }
  const ts = c.startTime != null ? ` @ ${formatTimestamp(c.startTime)}` : '';
  let who = '';
  if (c.speakerLabels.length === 1) who = `, ${c.speakerLabels[0]}`;
  else if (c.speakerLabels.length > 1) who = `, speakers: ${c.speakerLabels.join(', ')}`;
  return `[Session "${c.sessionTitle}"${ts}${who}]`;
}
```

**Step 4:** `npm run test:unit -- citation` → PASS; `npm run typecheck` → PASS.

**Step 5: Commit**

```bash
git add src/lib/citation.ts src/lib/__tests__/citation.test.ts
git commit -m "feat: citation formatting helper"
```

---

## Task 5: Add `embedTexts()` + `streamCampaignChat()` to `src/lib/ai.ts`

**Files:**
- Modify: `src/lib/ai.ts`
- Test: `src/lib/__tests__/ai.test.ts` (extend)

**Step 1: Failing test (mock determinism)**

Add to `ai.test.ts`:

```ts
import { embedTexts } from '@/lib/ai';

describe('embedTexts (mock mode)', () => {
  it('returns 768-dim deterministic vectors without hitting Gemini', async () => {
    const [a] = await embedTexts(['hello']);
    const [b] = await embedTexts(['hello']);
    const [c] = await embedTexts(['different']);
    expect(a).toHaveLength(768);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});
```

**Step 2:** `npm run test:unit -- ai` → FAIL.

**Step 3: Implement in `src/lib/ai.ts`**

Add imports: `import { embedMany, streamText, type CoreMessage } from 'ai';`
(`embedMany` and `streamText` come from `ai`; `google` is already imported.)

```ts
const EMBEDDING_DIM = 768;

function mockEmbedding(text: string): number[] {
  // Deterministic pseudo-vector from a simple rolling hash. Mock-only.
  const v = new Array<number>(EMBEDDING_DIM);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = (h ^ text.charCodeAt(i)) * 16777619;
  }
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    h = (h * 48271) % 2147483647;
    v[i] = (h % 1000) / 1000;
  }
  return v;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (isAiMocked()) return texts.map(mockEmbedding);
  const modelId = process.env.GOOGLE_EMBEDDING_MODEL || 'text-embedding-004';
  const { embeddings } = await embedMany({
    model: google.textEmbeddingModel(modelId),
    values: texts,
  });
  return embeddings;
}

const CHAT_SYSTEM_PROMPT =
  'You are a helpful assistant answering questions about a Dungeons & Dragons campaign. ' +
  'Answer ONLY using the provided context excerpts. If the context does not contain the ' +
  'answer, say you could not find it in the campaign records. When you use an excerpt, cite ' +
  'it inline using its bracketed citation tag exactly as given.';

export function buildChatMessages(
  context: string,
  history: { role: 'user' | 'assistant'; content: string }[],
): CoreMessage[] {
  return [
    { role: 'system', content: `${CHAT_SYSTEM_PROMPT}\n\nContext:\n${context}` },
    ...history,
  ];
}

export function streamCampaignChat(messages: CoreMessage[]) {
  const modelId = process.env.GOOGLE_SUMMARY_MODEL || 'gemini-2.5-flash';
  return streamText({ model: google(modelId), messages });
}
```

> Verify the installed `@ai-sdk/google` exposes `google.textEmbeddingModel`. If the
> API differs, adjust to the version's embedding helper — keep the function
> signature identical so callers/tests don't change.

**Step 4:** `npm run test:unit -- ai` → PASS; `npm run typecheck` → PASS.

**Step 5: Commit**

```bash
git add src/lib/ai.ts src/lib/__tests__/ai.test.ts
git commit -m "feat(ai): Gemini embeddings + campaign chat streaming helpers"
```

---

## Task 6: Reindex service (`src/services/campaignIndex.ts`)

**Files:**
- Create: `src/services/campaignIndex.ts`
- Test: `src/services/__tests__/campaignIndex.test.ts`

**Behavior:** `reindexSession(sessionId)` loads the session's transcriptions
(with speaker labels), summary, and DM TODO; builds chunks; embeds them; and
replaces the session's rows in `campaign_chunks` inside a transaction. Insert
uses `$executeRaw` with a pgvector literal because Prisma can't write the
`vector` column.

**Step 1: Failing test** (mock prisma + `embedTexts`)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/ai', () => ({ embedTexts: vi.fn(async (t: string[]) => t.map(() => new Array(768).fill(0.1))) }));

const tx = {
  $executeRaw: vi.fn(),
  $executeRawUnsafe: vi.fn(),
  campaignChunk: { deleteMany: vi.fn() },
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

beforeEach(() => vi.clearAllMocks());

it('deletes old chunks then inserts embedded chunks for the session', async () => {
  (prisma.gamingSession.findUnique as any).mockResolvedValue({ id: 's1', campaignId: 'c1' });
  (prisma.transcription.findMany as any).mockResolvedValue([
    { text: 'hello there', startTime: 0, endTime: 2, speakerCluster: { displayLabel: 'Thalia' } },
  ]);
  (prisma.summary.findUnique as any).mockResolvedValue({ summaryText: 'a summary' });
  (prisma.dmTodoList.findUnique as any).mockResolvedValue(null);

  await reindexSession('s1');

  expect(tx.campaignChunk.deleteMany).toHaveBeenCalledWith({ where: { sessionId: 's1' } });
  expect(tx.$executeRaw).toHaveBeenCalled(); // at least one insert
});

it('no-ops when the session does not exist', async () => {
  (prisma.gamingSession.findUnique as any).mockResolvedValue(null);
  await reindexSession('missing');
  expect(tx.campaignChunk.deleteMany).not.toHaveBeenCalled();
});
```

**Step 2:** `npm run test:unit -- campaignIndex` → FAIL.

**Step 3: Implement `src/services/campaignIndex.ts`**

```ts
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { embedTexts } from '@/lib/ai';
import { buildTranscriptChunks, type Segment } from '@/lib/chunking';
import { logger } from '@/lib/logger';

interface PendingChunk {
  sourceType: 'transcript' | 'summary' | 'dm_todo';
  chunkIndex: number;
  startTime: number | null;
  endTime: number | null;
  speakerLabels: string[];
  text: string;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

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
    sourceType: 'transcript',
    ...c,
  }));

  const summary = await prisma.summary.findUnique({ where: { sessionId }, select: { summaryText: true } });
  if (summary?.summaryText) {
    pending.push({ sourceType: 'summary', chunkIndex: pending.length, startTime: null, endTime: null, speakerLabels: [], text: summary.summaryText });
  }
  const todo = await prisma.dmTodoList.findUnique({ where: { sessionId }, select: { content: true } });
  if (todo?.content) {
    pending.push({ sourceType: 'dm_todo', chunkIndex: pending.length, startTime: null, endTime: null, speakerLabels: [], text: todo.content });
  }

  const embeddings = pending.length > 0 ? await embedTexts(pending.map((p) => p.text)) : [];

  await prisma.$transaction(async (tx) => {
    await tx.campaignChunk.deleteMany({ where: { sessionId } });
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      const vec = toVectorLiteral(embeddings[i]);
      await tx.$executeRaw`
        INSERT INTO campaign_chunks
          (id, campaign_id, session_id, source_type, chunk_index, start_time, end_time, speaker_labels, text, embedding, created_at)
        VALUES
          (gen_random_uuid(), ${session.campaignId}, ${sessionId}, ${p.sourceType}, ${p.chunkIndex},
           ${p.startTime}, ${p.endTime}, ${p.speakerLabels}, ${p.text}, ${vec}::vector, now())
      `;
    }
  });

  logger.info('Reindexed session chunks', { sessionId, chunks: pending.length });
}
```

> `id` uses `gen_random_uuid()` (pgcrypto/built-in in PG16) rather than cuid to
> keep the insert pure-SQL. If a cuid is required for consistency, generate it in
> JS and pass as a bind param instead.

**Step 4:** `npm run test:unit -- campaignIndex` → PASS; `npm run typecheck` → PASS.

**Step 5: Commit**

```bash
git add src/services/campaignIndex.ts src/services/__tests__/campaignIndex.test.ts
git commit -m "feat: campaign chunk reindex service"
```

---

## Task 7: Wire incremental indexing into the summary route

**Files:**
- Modify: `src/app/api/summary/[sessionId]/route.ts`

**Step 1:** Import the service near the other imports:

```ts
import { reindexSession } from '@/services/campaignIndex';
```

**Step 2:** After the summary is saved and status set to completed (just after
the `runNpcInference` block, before the success `logger.info`), add a
best-effort reindex that never fails the request:

```ts
// Index this session's content for campaign search/chat. Best-effort.
try {
  await reindexSession(sessionId);
} catch (err) {
  logger.error('Campaign reindex failed', err as Error, { sessionId });
}
```

**Step 3:** `npm run typecheck` → PASS; `npm run lint` → PASS.

**Step 4: Commit**

```bash
git add src/app/api/summary/[sessionId]/route.ts
git commit -m "feat: reindex campaign chunks after summary generation"
```

---

## Task 8: Backfill route `POST /api/campaigns/[id]/reindex` (owner-only)

**Files:**
- Create: `src/app/api/campaigns/[id]/reindex/route.ts`

**Step 1: Implement** (owner-only, rate-limited, test-account guarded)

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthForSensitiveAction } from '@/lib/auth-utils';
import { getCampaignAccess } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';
import { isAiMocked } from '@/lib/ai';
import { isTestAccount } from '@/lib/whitelist';
import { reindexSession } from '@/services/campaignIndex';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;
  const { error, user } = await requireAuthForSensitiveAction(request);
  if (error) return error;

  if (isTestAccount(user.email!) && !isAiMocked()) {
    return NextResponse.json({ error: 'Test accounts cannot use AI indexing.' }, { status: 403 });
  }

  const role = await getCampaignAccess(user.id, campaignId);
  if (role !== 'owner') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const sessions = await prisma.gamingSession.findMany({
    where: { campaignId, status: 'completed' },
    select: { id: true },
  });

  let indexed = 0;
  for (const s of sessions) {
    try {
      await reindexSession(s.id);
      indexed++;
    } catch (err) {
      logger.error('Backfill reindex failed', err as Error, { sessionId: s.id });
    }
  }

  return NextResponse.json({ message: 'Reindex complete', sessions: sessions.length, indexed });
}
```

**Step 2:** `npm run typecheck` → PASS; `npm run lint` → PASS.

**Step 3: Commit**

```bash
git add src/app/api/campaigns/[id]/reindex/route.ts
git commit -m "feat: owner-only campaign reindex backfill route"
```

---

## Task 9: Keyword search route `GET /api/campaigns/[id]/search`

**Files:**
- Create: `src/app/api/campaigns/[id]/search/route.ts`

**Step 1: Implement** (any member, no AI)

```ts
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
    SELECT cc.session_id          AS "sessionId",
           gs.title               AS "sessionTitle",
           cc.source_type         AS "sourceType",
           cc.start_time          AS "startTime",
           cc.speaker_labels      AS "speakerLabels",
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
```

**Step 2:** `npm run typecheck` → PASS; `npm run lint` → PASS.

**Step 3: Commit**

```bash
git add src/app/api/campaigns/[id]/search/route.ts
git commit -m "feat: campaign keyword search route (Postgres FTS)"
```

---

## Task 10: Chat route `POST /api/campaigns/[id]/chat`

**Files:**
- Create: `src/app/api/campaigns/[id]/chat/route.ts`

**Step 1: Implement** (any member, RAG + streaming, cost-guarded)

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCampaignAccess } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';
import { embedTexts, buildChatMessages, streamCampaignChat, isAiMocked } from '@/lib/ai';
import { isTestAccount } from '@/lib/whitelist';
import { formatCitation } from '@/lib/citation';

interface RetrievedRow {
  sessionTitle: string;
  sourceType: string;
  startTime: number | null;
  speakerLabels: string[];
  text: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;
  const access = await requireCampaignAccess(campaignId, 'any');
  if (!access.ok) return access.response;

  // Cost guard (chat spends money unless mocked).
  const user = await prisma.user.findUnique({ where: { id: access.userId }, select: { email: true } });
  if (user?.email && isTestAccount(user.email) && !isAiMocked()) {
    return NextResponse.json({ error: 'Test accounts cannot use AI chat.' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const messages: { role: 'user' | 'assistant'; content: string }[] = body?.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return NextResponse.json({ error: 'No question provided' }, { status: 400 });

  const [questionEmbedding] = await embedTexts([lastUser.content]);
  const vec = `[${questionEmbedding.join(',')}]`;

  const rows = await prisma.$queryRaw<RetrievedRow[]>`
    SELECT gs.title       AS "sessionTitle",
           cc.source_type AS "sourceType",
           cc.start_time  AS "startTime",
           cc.speaker_labels AS "speakerLabels",
           cc.text        AS "text"
    FROM campaign_chunks cc
    JOIN gaming_sessions gs ON gs.id = cc.session_id
    WHERE cc.campaign_id = ${campaignId}
    ORDER BY cc.embedding <=> ${vec}::vector
    LIMIT 8
  `;

  const context = rows
    .map((r) => `${formatCitation(r)}\n${r.text}`)
    .join('\n\n---\n\n');

  const result = streamCampaignChat(buildChatMessages(context, messages));
  return result.toTextStreamResponse();
}
```

> Confirm the streaming response helper name against the installed `ai` version
> (`toTextStreamResponse` / `toDataStreamResponse`). Match it to whatever the
> client `useChat` transport expects.

**Step 2:** `npm run typecheck` → PASS; `npm run lint` → PASS.

**Step 3: Commit**

```bash
git add src/app/api/campaigns/[id]/chat/route.ts
git commit -m "feat: campaign RAG chat route (pgvector KNN + Gemini stream)"
```

---

## Task 11: UI — search + chat panels on the campaign page

**Files:**
- Inspect first: `src/app/campaigns/[id]/page.tsx` (or equivalent campaign view — locate with grep)
- Create: `src/components/campaign/CampaignSearch.tsx`
- Create: `src/components/campaign/CampaignChat.tsx`
- Modify: the campaign page to render both (gated so any member sees them; show the Re-index button only to owners)

**Step 1:** Locate the campaign detail page and how it knows the viewer's role:

Run: `grep -rn "campaigns/\[id\]" src/app --include=page.tsx` and inspect.

**Step 2: `CampaignSearch.tsx`** — a debounced input calling
`GET /api/campaigns/${id}/search?q=`, rendering `result.snippet` (with the
`<mark>` highlight) as a link to `/sessions/${sessionId}` (append `#t=${startTime}`
if you later add timestamp deep-linking). Use React Query `useQuery` keyed on the
debounced term.

**Step 3: `CampaignChat.tsx`** — use Vercel AI SDK `useChat` pointed at
`/api/campaigns/${id}/chat`. Render streamed assistant messages; the bracketed
citation tags appear inline in the text (a later enhancement can linkify them).

**Step 4:** Render both in the campaign page. Show an owner-only "Re-index"
button that POSTs to `/api/campaigns/${id}/reindex` and surfaces the returned
counts.

**Step 5:** `npm run typecheck` → PASS; `npm run lint` → PASS; `npm run build` → PASS.

**Step 6: Commit**

```bash
git add src/components/campaign/ src/app/campaigns
git commit -m "feat(ui): campaign search + chat panels"
```

---

## Task 12: CI Postgres image must include pgvector

**Files:**
- Inspect: `playwright.config.ci.ts`, any testcontainers setup under `tests/` or `scripts/`, and `docker-compose.yml`.

**Step 1:** Find where the CI/integration Postgres image is specified (testcontainers
`new PostgreSqlContainer(...)` or a compose service).

**Step 2:** Change the image from `postgres:16*` to `pgvector/pgvector:pg16` so
`CREATE EXTENSION vector` in the migration succeeds. Apply the same change to the
local `docker-compose.yml` Postgres service if Task 2 required it.

**Step 3:** Run the CI integration suite locally if possible (`npm run test:ci`)
to confirm migrations apply and a basic flow passes.

**Step 4: Commit**

```bash
git add docker-compose.yml playwright.config.ci.ts tests scripts
git commit -m "ci: use pgvector Postgres image for integration tests"
```

---

## Task 13: Integration test (Playwright CI, mocked AI)

**Files:**
- Create: `tests/ci/campaign-chat.spec.ts`

**Coverage (with `MOCK_AI_SERVICES=true`):**
1. Create campaign + session, seed a transcription + summary (or run the mocked
   pipeline), POST `/reindex` as owner → 200 with `indexed >= 1`.
2. GET `/search?q=<word from mock transcript>` → returns ≥1 result with a snippet.
3. POST `/chat` with a question → streamed 200 response containing a citation tag.
4. A non-member (different account) gets 404 from `/search` and `/chat`.
5. A `@test.com` account with AI **not** mocked would get 403 from `/chat`
   (assert the guard exists; can be a unit-level assertion if simpler).

Run: `npm run test:ci -- campaign-chat`
Expected: PASS.

**Commit**

```bash
git add tests/ci/campaign-chat.spec.ts
git commit -m "test(ci): campaign search + chat integration"
```

---

## Task 14: Infra (deploy repo) + docs

**Files:**
- Modify: `LESSONS.md` (append a pgvector/Azure note)
- Deploy repo `Domo929/dnd-recorder-deploy` (separate): allow-list `vector` via
  the Postgres Flexible Server `azure.extensions` server parameter **before** the
  release migration runs, else `prisma migrate deploy` fails on `CREATE EXTENSION`.

**Step 1:** Append to `LESSONS.md` under a new "## AI services" entry:

> Campaign chat/search uses pgvector. The `vector` extension must be allow-listed
> via Azure Postgres Flexible Server's `azure.extensions` parameter before the
> release migration runs. CI/integration Postgres must use `pgvector/pgvector:pg16`.
> Embeddings are `text-embedding-004` (768-dim) — changing the model means a
> dimension change → new migration + full re-embed.

**Step 2:** Track the Azure parameter change in the deploy repo (out of band).

**Step 3: Commit**

```bash
git add LESSONS.md
git commit -m "docs: pgvector/Azure lessons for campaign chat"
```

---

## Final verification (before PR)

- `npm run test:unit` → all PASS
- `npm run typecheck` → PASS
- `npm run lint` → PASS
- `npm run build` → PASS
- `npm run test:ci` → PASS (pgvector image)
- Self code-review via the code-review agent; fix findings before merging
  (required per repo workflow). Share the PR link when requesting feedback.

## Open items to confirm during implementation

- `@ai-sdk/google` embedding API surface (`google.textEmbeddingModel` vs alt).
- `ai` streaming response helper name (`toTextStreamResponse` vs `toDataStreamResponse`)
  and the matching `useChat` transport config.
- Whether `gen_random_uuid()` is acceptable for `campaign_chunks.id` or a cuid is required.
- HNSW vs ivfflat index (HNSW needs pgvector ≥ 0.5.0; `pgvector/pgvector:pg16` ships it).
