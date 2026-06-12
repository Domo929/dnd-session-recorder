# Campaign AI Chat + Search — Design

**Date:** 2026-05-30
**Status:** Approved design, pending implementation

## Goal

Let any campaign member (owner or shared player) do two things over the
*entire* campaign's content:

- **A. Keyword search** — find an exact name/phrase across all transcriptions,
  summaries, and DM TODO lists, with ranked snippets that link to the source
  session and timestamp.
- **B. Ask chat** — multi-turn natural-language questions answered via
  retrieval-augmented generation (RAG) over the campaign's content, with
  citations back to the source session/timestamp/speaker.

Provider: **Gemini** for both embeddings (`text-embedding-004`, 768-dim) and
chat (`gemini-2.5-flash`), routed through the existing `src/lib/ai.ts`
provider-agnostic layer.

Chat is **multi-turn but ephemeral**: the client holds the message history and
sends it with each request; nothing is persisted to the database.

## Architecture

```
Campaign page
 ├─ Search panel ──→ GET  /api/campaigns/[id]/search?q=   (Postgres FTS, no AI)
 └─ Chat panel  ──→ POST /api/campaigns/[id]/chat         (RAG + Gemini, streaming)
                          │
                          ├─ embed(question)         → Gemini text-embedding-004
                          ├─ pgvector KNN over campaign's chunks
                          └─ streamText(context+history) → gemini-2.5-flash
```

Both features share one access guard: `requireCampaignAccess(id, 'any')`
(owners and players).

### Shared substrate: the chunk index

A new `TranscriptChunk` table holds derived, searchable, embeddable units of
campaign content. Chunks are **derived data** — backfill and incremental
indexing are both "delete this session's chunks, re-insert," so every operation
is idempotent and safe to re-run.

Sources chunked:
- `Transcription` segments — merged into ~500–800 token windows, preserving
  timestamps and the set of speakers in the window.
- `Summary` — one chunk per summary.
- `DmTodoList` — one chunk per list.

## Schema & migration

Enable pgvector in Prisma:

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

New model (Prisma cannot express the vector column type natively, so
`embedding` uses `Unsupported`, and KNN search runs via `$queryRaw`):

```prisma
model TranscriptChunk {
  id            String   @id @default(cuid())
  campaignId    String   @map("campaign_id")
  sessionId     String   @map("session_id")
  sourceType    String   @map("source_type") // transcript | summary | dm_todo
  chunkIndex    Int      @map("chunk_index")
  startTime     Float?   @map("start_time")
  endTime       Float?   @map("end_time")
  speakerLabels String[] @map("speaker_labels") // distinct speakers in the window
  text          String   @db.Text
  embedding     Unsupported("vector(768)")?
  createdAt     DateTime @default(now()) @map("created_at")

  campaign Campaign      @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  session  GamingSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([campaignId])
  @@index([sessionId])
  @@map("transcript_chunks")
}
```

Add back-relations `transcriptChunks TranscriptChunk[]` on `Campaign` and
`GamingSession`.

Migration adds what Prisma can't:
- `CREATE EXTENSION IF NOT EXISTS vector;`
- HNSW index for cosine KNN:
  `CREATE INDEX ... ON transcript_chunks USING hnsw (embedding vector_cosine_ops);`
- A generated `tsvector` column `text_search` over `text`, plus a `GIN` index —
  this powers Part A keyword search with ranking and highlighting.

**Azure note:** Postgres Flexible Server supports `vector`, but the extension
must be allow-listed via the server's `azure.extensions` parameter before the
release migration runs. This is a one-time infra step handled in the deploy
repo (`Domo929/dnd-recorder-deploy`).

## Chunking (`src/lib/chunking.ts`)

Pure, dependency-free, unit-tested:

- `buildChunks(session)` merges consecutive `Transcription` segments into
  ~500–800 token windows, carrying `startTime` (first segment in window),
  `endTime` (last segment), and `speakerLabels` — the **distinct, order-preserved,
  deduped** set of speaker labels across the merged segments. If multiple people
  spoke in the window we still capture the full list; single-speaker windows are
  a one-element array.
- `Summary` and `DmTodoList` each become one chunk with `speakerLabels = []`.
- Returns rows ready to embed (no AI in this module → easy boundary/merge tests).

## Embedding & indexing

In `src/lib/ai.ts` (never inline — all AI calls live here):
- `embedTexts(texts: string[]): Promise<number[][]>` → Gemini
  `text-embedding-004`, batched. Under `MOCK_AI_SERVICES=true` returns a stable
  hash→768-vector so tests need no API key.

In a `reindexService`:
- `reindexSession(sessionId)`: within a transaction, delete existing chunks for
  the session, build chunks, embed, and bulk-insert via `$executeRaw` (vector
  literal). Idempotent.
- **Incremental:** call `reindexSession` at the end of the summary route,
  best-effort and logged, never failing the summary — same pattern as
  `runNpcInference`.
- **Backfill:** `POST /api/campaigns/[id]/reindex` (owner-only) iterates the
  campaign's completed sessions. Rate-limited via `requireAuthForSensitiveAction`,
  guarded by the `isTestAccount` block.

## Routes

### A. `GET /api/campaigns/[id]/search?q=`
- Access: any member. No AI spend, no test-account block.
- Postgres FTS: `websearch_to_tsquery` over `text_search`, ordered by `ts_rank`,
  snippets via `ts_headline`.
- Returns `{ sessionId, sessionTitle, startTime, speakerLabels, snippet }[]`.

### B. `POST /api/campaigns/[id]/chat`
- Access: any member; `isTestAccount(email) && !isAiMocked()` → 403 (spends
  money). Rate-limited via `requireAuthWithRateLimit`.
- Body: `{ messages: [...] }` — client holds history; nothing persisted.
- Embed the latest user question → pgvector KNN
  (`ORDER BY embedding <=> $1 LIMIT k`) scoped to `campaignId` → assemble a
  context block with citation tags.
- `streamText` (Vercel AI SDK) with a system prompt instructing the model to
  answer **only** from the provided context and to cite sources → streamed to
  the `useChat` client.

### Citation format
- One speaker: `[Session "Title" @ 1:02:15, Thalia]`
- Multiple speakers: `[Session "Title" @ 1:02:15, speakers: Thalia, Bren, DM]`
- Summary/DM-TODO chunks: `[Session "Title" — summary]`

Citations render in the UI as chips linking to `/sessions/[id]` at the
timestamp.

## UI (campaign page)

- **Search** box (debounced) → ranked snippet hits, each linking to the source
  session at its timestamp.
- **Chat** panel using Vercel AI SDK `useChat` against the chat route —
  streaming answers, citation chips as links. History in component state only.
- Owner-only **index status / Re-index** affordance.

## Testing (three stages per LESSONS.md)

- **Vitest (fast gate):** `chunking.ts` merge/boundary/speaker-set logic,
  citation formatting, search-query builder, mock-embedding determinism,
  `reindexSession` delete/insert logic (mocked prisma).
- **Playwright CI (testcontainers + `MOCK_AI_SERVICES`):** migration applies
  pgvector in the test Postgres image; reindex → search returns hits → chat
  returns a mocked grounded answer with a citation. Test Postgres image must
  include the pgvector extension.
- **Staging post-deploy:** real Gemini embed + chat against a tiny fixture
  campaign.

## Out of scope (YAGNI)

- Persisted chat threads / conversation history in the DB.
- Local/Ollama LLM (App Service B2 has no GPU; revisit later).
- Cross-campaign search.
- Long-context "stuff everything in the prompt" fallback.
