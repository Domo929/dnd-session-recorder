# Resumable, Rate-Limited Transcription

## Problem

Transcription splits a session's audio into N provider-sized chunks
(106 for a long session), transcribes them sequentially through Google
Gemini, accumulates the text **in memory**, and saves a single
`Transcription` row only at the very end. Two failure modes hurt:

1. **No resumability.** Any chunk failure throws away all partial work.
   The existing Retry button re-runs from chunk 1, re-paying for every
   already-transcribed chunk.
2. **Free/low-tier rate limits.** Gemini returns
   `429 RESOURCE_EXHAUSTED` ("retry in 58s") once the per-minute request
   quota is exceeded. The AI SDK's built-in retry only waits a few
   seconds across 3 attempts — far short of the server's requested delay —
   so the whole job fails mid-run.

Transcription does **not** run on the GPU diarization VMs (those only do
speaker diarization). Transcription is a Gemini API call, so its limits
are Google-side quotas, not our compute.

## Goals

- Persist each chunk's transcript the instant it succeeds, so retries
  (manual or automatic) skip completed chunks.
- Pace requests to stay safely under the provider's RPM limit.
- On rate-limit/overload errors, honor the server's suggested retry delay
  with bounded retries before failing.
- Keep the existing Retry button and error banner unchanged — they simply
  resume now.

## Non-goals (YAGNI)

- The speaker-labeled / diarization pipeline (separate code path).
- Parallel chunk requests.
- UI changes beyond the existing error banner.

## Data model

New model:

```prisma
model TranscriptionChunk {
  id         Int      @id @default(autoincrement())
  sessionId  String   @map("session_id")
  chunkIndex Int      @map("chunk_index")
  text       String   @db.Text
  createdAt  DateTime @default(now()) @map("created_at")
  session    GamingSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@unique([sessionId, chunkIndex])
  @@index([sessionId])
  @@map("transcription_chunks")
}
```

New field on `GamingSession`:

```prisma
transcriptionChunkCount Int? @map("transcription_chunk_count")
```

`transcriptionChunkCount` is the chunk count from the run that produced
the saved rows — a **chunking signature**. Chunks are re-split by size on
every run; the split is deterministic for the same audio + chunk-size,
but if the provider/env (and thus `maxTranscriptionChunkSizeMB`) or the
audio change, the saved indices would no longer line up. On retry we
compare the fresh split's count to `transcriptionChunkCount`:

- **Match** → resume (load saved rows, skip those indices).
- **Mismatch / null** → discard partial rows, set the new count, start
  fresh.

Cascade delete cleans rows up with the session; rows are also cleared at
the start of a fresh run and after the final transcript is stitched.

## Pacing + adaptive backoff

Both layers live in `src/lib/ai.ts` (provider-agnostic) and are
env-configurable with safe defaults.

**Inter-chunk pacing.** A minimum interval between requests derived from
`TRANSCRIPTION_MAX_RPM` (default `60` → 1 req/sec). Tracked via a
last-request timestamp; `await sleep(gap)` if the next request would be
too soon. Sequential chunks make a token bucket unnecessary.

**Adaptive backoff.** `transcribeAudio` is wrapped in a retry loop that:

- catches rate-limit / overload errors (`429`, `RESOURCE_EXHAUSTED`,
  `503`, "high demand", "quota");
- parses the server's suggested delay (Gemini `RetryInfo` /
  "retry in Xs"), falling back to exponential backoff
  (`5s → 15s → 45s`, capped);
- retries up to `TRANSCRIPTION_CHUNK_MAX_RETRIES` (default `5`);
- re-throws non-retryable errors (bad audio, auth) immediately.

The AI SDK's own retry is disabled (`maxRetries: 0`) so our loop is the
single source of truth for retry behavior.

### Env vars

| Var | Default | Meaning |
|-----|---------|---------|
| `TRANSCRIPTION_MAX_RPM` | `60` | Max transcription requests per minute (pacing). |
| `TRANSCRIPTION_CHUNK_MAX_RETRIES` | `5` | Backoff attempts per chunk before failing. |
| `TRANSCRIPTION_BACKOFF_BASE_MS` | `5000` | First fallback backoff when no server hint. |
| `TRANSCRIPTION_BACKOFF_MAX_MS` | `60000` | Backoff cap. |

## Run flow (`/api/transcription/[sessionId]` POST)

1. Materialize audio → `splitAudioBySize` → `chunkPaths` (unchanged).
2. **Signature check:** if `transcriptionChunkCount === chunkPaths.length`,
   load existing `TranscriptionChunk` rows into `Map<index, text>`.
   Else wipe partial rows and set
   `transcriptionChunkCount = chunkPaths.length`.
3. Loop chunks in order:
   - If index is in the map → skip (instant resume), still advance
     progress.
   - Else: pace → transcribe-with-backoff → **upsert**
     `TranscriptionChunk(sessionId, index, text)` immediately → update
     `chunksCompleted` / progress.
4. Once every index has text: stitch in index order →
   `saveTranscription` → clear chunk rows → mark session `transcribed`.

A crash, quota failure, or manual retry at any point never re-does a
chunk whose row is already persisted.

## Error handling

- Chunk fails after all backoff retries → existing behavior: route
  catches, `db.setSessionError(sessionId, 'transcription', msg)`, status
  `error`, banner shows Retry. Persisted chunk rows remain for the resume.
- Non-retryable provider error → fails fast (no pointless backoff).
- Signature mismatch → safe full restart (never stitches mismatched
  chunks).

## Testing (vitest, mirroring existing patterns)

- **DB helpers:** upsert chunk, `getTranscriptionChunks`, clear chunks;
  signature read/write.
- **Backoff util:** parses "retry in Xs" and honors it; falls back to
  exponential; caps; gives up after N; passes non-retryable errors
  through. Mock timers.
- **Pacing util:** enforces the min interval between calls.
- **Route-level:** resume skips persisted chunks and only transcribes
  missing ones; signature mismatch wipes and restarts; success stitches
  in order and clears rows. Mock `transcribeAudio`, db, storage.
