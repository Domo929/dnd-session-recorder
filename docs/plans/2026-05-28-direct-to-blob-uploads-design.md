# Direct-to-Blob uploads — design

**Date:** 2026-05-28 (rewritten 2026-05-29 against the upstream-aligned base)
**Status:** Approved, ready for implementation
**Author:** brainstormed with Copilot CLI

> Rewritten in Phase D after re-founding the fork on `upstream/staging`. This
> version targets the aligned upload flow (`create-with-upload`, the standalone
> `/api/uploads`, the per-session `/api/sessions/[id]/upload`, `Upload.path`,
> and the chunk-then-`transcribeAudio(Buffer)` transcription pipeline). Azure
> Blob storage stays a fork-specific concern — **not** an upstream PR. See
> `files/upstream-alignment-master-plan.md` Phase D.

## Goal

Lift the practical upload size ceiling from "~100 MB or you OOM the B2 App
Service instance" to "as large as you want (default cap 2 GB)" by moving
session-audio uploads off the app server entirely.

Today **three** routes accept audio and each reads `request.formData()` fully
into memory, then `writeFile`s to `uploadDir` (`/app/data/uploads` in prod):

- `POST /api/uploads` — standalone upload, returns an `Upload` row.
- `POST /api/sessions/create-with-upload` — atomic create: upload + create
  `GamingSession` + fire the processing pipeline in one request.
- `POST /api/sessions/[id]/upload` — attach/replace audio on an existing session.

All three gate on `MAX_FILE_SIZE` (default 100 MB). A 1 GB upload either gets
rejected, or — if we just bumped the cap — OOMs the 3.5 GB App Service
instance. Azure's front-end proxy also caps request bodies independently of our
limit.

The fix: browsers PUT directly to Azure Blob Storage with a short-lived,
single-blob-scoped SAS URL. The app never sees the file bytes, only metadata.
RAM stays flat regardless of file size. Multi-GB sessions become trivial.

This work also stands up the Azure Blob Storage infrastructure that the
upcoming **speaker-labels** feature (see
`docs/plans/2026-05-27-speaker-labels-design.md`) assumes exists — same storage
account, second container (`voice-samples`) created empty.

## Decisions

| Question | Decision |
| --- | --- |
| Browser → Blob upload mechanism | `@azure/storage-blob` browser SDK with `BlockBlobClient.uploadData()`. Handles multi-block, parallel, progress, retry. |
| App → Blob authentication | Managed identity via `DefaultAzureCredential`. No shared key, no connection string, no secret to rotate. Local dev/CI use an Azurite connection string. |
| Browser → Blob authentication | User-delegation SAS issued by the app, 30 min TTL, scoped to a single blob path, create+write only. |
| Blob naming | `uploads/{userId}/{timestamp}-{uuid}.{ext}` — user-namespaced so cross-user access is path-impossible even before RBAC. (Keeps the existing `${Date.now()}-${uuidv4()}` filename convention from `create-with-upload`.) |
| Storage account topology | One shared account; containers `audio-sessions` (this work) + `voice-samples` (speaker-labels later, created empty here). |
| Atomic create flow | `create-with-upload` keeps its single-request "create session + trigger processing" contract, but accepts a `blobPath` (referencing an already-PUT blob) instead of an `audio` File. The browser PUTs to Blob first, then calls it. |
| Existing file handling | One-shot migration script uploads every existing local file to Blob and rewrites `Upload.path` + `storage='blob'`, deletes the local copy on success. |
| Backwards-compat window | `Upload.storage` enum (`local \| blob`) lets the read path tolerate both during the migration window; new rows always `blob`. |
| Max upload size | Default 2 GB (`MAX_FILE_SIZE=2147483648`). Enforced at SAS-issue time (rejects if `size > limit`) AND re-verified against the actual blob size before the `Upload` row is created. |
| CORS | Storage account allows `PUT, GET, HEAD, OPTIONS` from app origins (prod hostname + `http://localhost:3000` for dev). 1 h max-age. |
| Smoke test backend | Azurite sidecar in `docker-compose.smoke.yml`. Identical Azure SDK code, connection string differs. |
| Audio retention | Deferred to speaker-labels feature. `Upload.audioExpiresAt` (nullable) added here so the cron there has a column to work with; left null in this work. |
| Failure mode if Blob is unreachable | `/api/uploads/sas` returns 503 with a clear error. The UI surfaces "Storage temporarily unavailable" instead of silently falling back to local disk (a footgun). |

## Section 1 — API surface

The single-shot multipart POSTs become a **two-step SAS handshake** plus a
refactored atomic-create route.

### `POST /api/uploads/sas`

Issues a one-blob upload URL. Replaces the body-reading portion of every
upload route.

**Request:**
```json
{ "originalName": "session-001.m4a", "mimetype": "audio/mp4", "size": 524288000 }
```

**Response (200):**
```json
{
  "sasUrl": "https://dndrec.blob.core.windows.net/audio-sessions/uploads/user_123/1730000000000-uuid.m4a?sv=...&sig=...",
  "blobPath": "uploads/user_123/1730000000000-uuid.m4a",
  "expiresAt": "2026-05-28T18:14:00Z"
}
```

**Errors:** 401 (not signed in) · 400 (`mimetype` not in the existing allow
list) · 413 (`size > MAX_FILE_SIZE`) · 503 (user-delegation key unobtainable).

The SAS is generated with `BlobSASPermissions.from({ create: true, write: true })`
(no read, no delete), resource scope = single blob (`b`), TTL 30 min, signed
with the user-delegation key (no account key).

### `POST /api/uploads/complete`

The standalone-upload counterpart to today's `POST /api/uploads`. Turns a
landed blob into an `Upload` row.

**Request:** `{ "blobPath", "originalName", "mimetype", "size" }`

**Server-side processing:**
1. Verify the signed-in user owns `blobPath` (starts with `uploads/{userId}/`).
2. HEAD the blob; read the real size from `Content-Length`.
3. Reject if the real size differs from the client-supplied size (defense
   against a client lying to bypass the SAS-time `MAX_FILE_SIZE` check).
4. `materializeToTempFile` → run the existing ffprobe `getAudioDuration`
   helper → delete the temp file.
5. Insert `Upload` with `path = blobPath`, `storage = 'blob'`,
   `duration = probedSeconds` (reusing `db.createUpload`).
6. Return the `Upload` row.

**Errors:** 401 · 403 (ownership) · 404 (blob never PUT) · 422 (size mismatch) ·
422 (ffprobe fails — delete the blob, return error).

### `POST /api/sessions/create-with-upload` (refactored)

Keeps its atomic contract but its `audio` File field becomes `blobPath`
(+`originalName`,`mimetype`,`size`). Internally it runs the same steps 1–5 as
`/complete` to mint the `Upload`, then proceeds unchanged: `db.createSession({
… uploadId, status: 'uploaded' })` and the fire-and-forget
`fetch('/api/sessions/{id}/process')`. The 207-multi-status error path is
preserved.

### `POST/PUT /api/sessions/[id]/upload` (refactored)

Same File→`blobPath` swap; mints the `Upload` via the shared helper and links
it to the existing session.

A shared `createUploadFromBlob(user, { blobPath, originalName, mimetype, size })`
helper (in `src/services/storage/`) holds steps 1–5 so `/complete`,
`create-with-upload`, and `[id]/upload` don't duplicate the HEAD/size/probe
logic.

## Section 2 — Storage abstraction

```ts
// src/services/storage/types.ts
export type StorageBackend = 'azure-blob' | 'azurite' | 'local';

export interface StorageService {
  readonly backend: StorageBackend;

  /** Issue a time-limited upload URL the browser can PUT directly to. */
  issueUploadUrl(opts: {
    userId: string; originalName: string; mimetype: string; size: number;
  }): Promise<{ uploadUrl: string; blobPath: string; expiresAt: Date }>;

  /** Verify a previously-issued upload actually landed. Returns the real size. */
  head(blobPath: string): Promise<{ exists: boolean; size: number }>;

  /** Download to a unique temp path. Caller must delete when done. */
  materializeToTempFile(blobPath: string): Promise<string>;

  /** Permanently delete. Used during deletion + on a failed complete/probe. */
  delete(blobPath: string): Promise<void>;
}
```

**Implementations:**

- `AzureBlobStorageService` — production. `BlobServiceClient` from
  `DefaultAzureCredential` + `AZURE_BLOB_ACCOUNT_NAME`. SAS via
  `getUserDelegationKey()` + `generateBlobSASQueryParameters()`.
- `AzuriteStorageService` — dev + smoke. Identical SDK code, constructed from
  `AZURE_STORAGE_CONNECTION_STRING` (Azurite's well-known string). Azurite 3.x
  supports user-delegation SAS.
- `LocalDiskStorageService` — fallback for environments with neither var.
  Preserves the current `uploadDir` behaviour and proxies "uploads" through a
  server-side passthrough endpoint instead of issuing real SAS URLs
  (`uploadUrl = /api/uploads/local-passthrough/{token}`). Kept ONLY so unit
  tests + ad-hoc `npm run dev` without Docker still work. Production must use a
  Blob backend.

**Selection logic** (`src/services/storage/index.ts`):
```ts
if (process.env.AZURE_BLOB_ACCOUNT_NAME) return new AzureBlobStorageService();
if (process.env.AZURE_STORAGE_CONNECTION_STRING) return new AzuriteStorageService();
return new LocalDiskStorageService();
```
Logged once at boot: `[storage] backend=<azure-blob|azurite|local>`.

## Section 3 — Consumer integration (aligned call sites)

Every place that today treats `Upload.path` as a local file path must run
through a materialize helper instead:

```ts
// src/services/storage/materialize.ts
export async function withMaterializedAudio<T>(
  upload: { path: string; storage: 'local' | 'blob' },
  fn: (localPath: string) => Promise<T>,
): Promise<T> {
  if (upload.storage === 'local') return fn(upload.path); // already local
  const tempPath = await getStorageService().materializeToTempFile(upload.path);
  try { return await fn(tempPath); }
  finally { await fs.promises.unlink(tempPath).catch(() => {}); }
}
```

**Call sites to convert (verified against the aligned tree):**

- **`src/app/api/transcription/[sessionId]/route.ts`** — the hot path. Today it
  does `const fullPath = session.upload.path; fs.existsSync(fullPath);
  splitAudioBySize(fullPath, …)`. Wrap the whole "split → loop chunks →
  cleanup" body in `withMaterializedAudio(session.upload, async (localPath) =>
  { … })`. The blob is downloaded once to a temp file, chunked locally by
  `splitAudioBySize`, each chunk `fs.readFileSync` → `transcribeAudio(Buffer)`,
  then the temp file is removed in the `finally`. The existing
  "file-missing → reconcile DB row" branch becomes "blob `head().exists ===
  false` → reconcile".
- **`src/services/audioProcessing.ts`** — `getAudioDuration`, `splitAudioBySize`,
  `validateAudioFile` keep operating on a local path; they just receive the
  materialized temp path. `resolveUploadPath(filename)` (which maps a filename
  to a local `uploadDir` path) is only meaningful for `storage='local'`; blob
  rows never call it.
- **`create-with-upload` / `/complete` / `[id]/upload` ffprobe step** — the
  duration probe (`getAudioDuration`) runs against the materialized temp file
  (Section 1, step 4), not a permanent local file.
- **`src/services/fileCleanup.ts`** — `cleanupSessionFiles` and friends delete
  local files today. For `storage='blob'` uploads, deletion goes through
  `getStorageService().delete(blobPath)`; local chunk temp files created during
  transcription are still cleaned by `cleanupChunkFiles` as now.

The transcription provider layer (`src/lib/ai.ts`: `transcribeAudio(Buffer)`,
`maxTranscriptionChunkSizeMB()`) is **unchanged** — it already takes in-memory
buffers, so it neither knows nor cares where the bytes originated. This is the
big simplification versus the pre-alignment design, which assumed per-provider
`transcribe(audioPath)` services in `src/services/ai/*`.

## Section 4 — Schema change

Single Prisma migration, additive on the aligned `Upload` model:

```prisma
enum UploadStorage { local  blob }

model Upload {
  // ... existing fields (id, userId, filename, originalName, path, size,
  //     mimetype, duration, status, chunkPaths, …)
  storage        UploadStorage @default(blob)
  audioExpiresAt DateTime?     @map("audio_expires_at")
}
```

`audioExpiresAt` is unused here — speaker-labels will populate + purge against
it. Co-located so we don't need a second migration for one column.

`@default(blob)` is correct for rows inserted **after** the migration. Existing
rows predate it, so the same migration includes
`UPDATE "uploads" SET storage = 'local' WHERE created_at < NOW();` to make the
rollout window safe (the Prisma default applies only to inserts, not backfill).
The Section 5 script then flips those rows to `blob` as files move.

## Section 5 — Migration script

`scripts/migrate-uploads-to-blob.ts`:

1. Load env. Refuse to run unless `AZURE_BLOB_ACCOUNT_NAME` is set (never
   migrate prod data into Azurite — data-loss footgun).
2. `SELECT * FROM "uploads" WHERE storage = 'local'`.
3. For each row, **serially** (no concurrency — keep RAM flat):
   a. `fs.statSync(row.path)`. Missing file → log + skip (orphan DB row).
   b. New blob path `uploads/{userId}/{row.filename}` (filename already carries
      the `{timestamp}-{uuid}` — no rename).
   c. Stream-upload via `BlockBlobClient.uploadFile()`.
   d. HEAD the blob, verify size.
   e. `UPDATE "uploads" SET path=$blobPath, storage='blob' WHERE id=$id`.
   f. `fs.unlinkSync(row.path)`.
4. Print `Migrated N, skipped M (missing), failed K`.

Idempotent — only touches rows still `'local'`, re-runs cleanly after an
interrupt. Triggered manually post-deploy:
`docker exec <container> node /app/scripts/migrate-uploads-to-blob.js`
(not on boot — explicit human-in-the-loop the first time).

## Section 6 — Frontend changes

The upload forms in `src/app/sessions/upload/page.tsx` and the session detail
page change from a single multipart POST to the three-step flow:

```ts
import { BlockBlobClient, AnonymousCredential } from '@azure/storage-blob';

// 1. Get SAS
const { sasUrl, blobPath } = await fetch('/api/uploads/sas', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ originalName: file.name, mimetype: file.type, size: file.size }),
}).then(r => r.ok ? r.json() : Promise.reject(r));

// 2. Upload directly to Blob with REAL progress
const client = new BlockBlobClient(sasUrl, new AnonymousCredential());
await client.uploadData(file, {
  blockSize: 4 * 1024 * 1024, concurrency: 4,
  onProgress: ({ loadedBytes }) => setProgress(loadedBytes / file.size),
});

// 3. Atomic create (or /complete for the standalone path)
const { session } = await fetch('/api/sessions/create-with-upload', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title, campaign_id, session_date, blobPath,
    originalName: file.name, mimetype: file.type, size: file.size }),
}).then(r => r.json());
```

Real progress is now possible — replace the spinner with a `<progress>` bar
driven by `onProgress`. (Note `create-with-upload` now takes JSON, not
multipart.)

**On failure mid-upload:** `uploadData` auto-retries; if it ultimately fails we
POST nothing downstream and the orphan blob ages out via a Blob lifecycle rule
(deploy repo: "delete blobs older than 7 days under `uploads/`"). V1 may skip
the lifecycle rule and accept some orphans — cleanup is a follow-up.

## Section 7 — Infrastructure (deploy repo)

Changes go in `Domo929/dnd-recorder-deploy`:

- New Bicep module `infra/modules/storage.bicep`:
  - Storage account (StorageV2, hot, LRS, 7 d soft-delete for blobs +
    containers, public blob access **disabled**).
  - Two private containers: `audio-sessions`, `voice-samples`.
  - CORS: `PUT, GET, HEAD, OPTIONS` from `https://<app-hostname>` and
    `http://localhost:3000`, 1 h max-age.
  - Role assignment: App Service system-assigned managed identity gets
    `Storage Blob Data Contributor` on the account.
- New App Service settings:
  - `AZURE_BLOB_ACCOUNT_NAME=<account>`
  - `AZURE_BLOB_AUDIO_CONTAINER=audio-sessions`
  - `AZURE_BLOB_VOICE_CONTAINER=voice-samples` (speaker-labels)
  - `MAX_FILE_SIZE=2147483648`
- App Service system-assigned identity enabled (if not already).

CORS is the most likely prod gotcha — the SDK does a preflight OPTIONS before
every PUT, and a bad rule presents as "uploads hang" with no app-side error.
Azurite validates the SDK call shape but NOT CORS, so a manual post-deploy
"upload a 50 MB file" step goes in the deploy runbook.

## Section 8 — Smoke + tests

**Azurite in smoke compose:**
```yaml
services:
  azurite:
    image: mcr.microsoft.com/azure-storage/azurite:latest
    command: azurite-blob --blobHost 0.0.0.0 --skipApiVersionCheck
    healthcheck:
      test: ["CMD", "nc", "-z", "localhost", "10000"]
      interval: 5s
      timeout: 3s
      retries: 5
  dnd-recorder:
    environment:
      - AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://azurite:10000/devstoreaccount1;
    depends_on:
      azurite: { condition: service_healthy }
```

`AzuriteStorageService` constructs `BlobServiceClient` from that string and
`createIfNotExists` the `audio-sessions` container on boot. The existing
Playwright smoke spec stays at the UI layer (`setInputFiles` + submit), so it
exercises the full SAS flow end-to-end; the "upload silence.wav → expect
Session Created" assertion is unchanged.

**Unit tests added:**
- `src/services/storage/__tests__/azure.test.ts` — round-trip against Azurite
  (issueUploadUrl → PUT via SDK → head → materialize → delete).
- `src/app/api/uploads/__tests__/sas-and-complete.test.ts` — auth gating, mime
  validation, ownership, size-mismatch detection.
- `scripts/migrate-uploads-to-blob.test.ts` — synthetic `Upload` rows + temp
  files; idempotency + missing-file handling.

These run under `vitest` (the aligned test runner) alongside the existing 68.

## Section 9 — Rollout sequence

1. Ship infra (deploy repo): account + containers + RBAC + CORS + env vars. App
   still works (doesn't read the new vars yet).
2. Merge this app change. New uploads go to Blob. Existing rows stay `'local'`,
   served from disk via `LocalDiskStorageService` + `withMaterializedAudio`.
3. Run `node scripts/migrate-uploads-to-blob.js` inside the App Service
   container. Verify the summary line.
4. Manual verification: upload a 50 MB file end-to-end (CORS smoke).
5. Optional follow-up: drop `LocalDiskStorageService` + the `'local'` enum
   variant once no `'local'` rows remain.

## What's deferred

- **14 d retention cron** — `Upload.audioExpiresAt` added here, but the daily
  purge lives with speaker-labels.
- **Orphan-blob cleanup** — failed mid-`uploadData` blobs; deferred to a Blob
  lifecycle rule (7 d age-out under `uploads/`).
- **Resumable uploads across browser refresh** — `uploadData` resumes within a
  session via block IDs, but the block list is in-memory only. Tab close =
  restart. Could persist block lists in `localStorage`; not V1.
- **Server-side virus scan** — direct uploads bypass any "server inspects the
  bytes" hook. Not needed today (DM's own audio of their own session); noted.

## Open questions

None blocking. To revisit in prod:
- Does the Azure region matter for upload latency from US-central users?
  (Likely no — Blob is co-located with the App Service.)
- Is 4 MB block size optimal? Default works; tune later if metrics show it.
