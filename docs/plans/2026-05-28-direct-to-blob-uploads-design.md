# Direct-to-Blob uploads — design

**Date:** 2026-05-28
**Status:** Approved, ready for implementation
**Author:** brainstormed with Copilot CLI

## Goal

Lift the practical upload size ceiling from "~100 MB or you OOM the B2 instance"
to "as large as you want (default cap 2 GB)" by moving session-audio uploads
off the app server entirely.

Today the upload route reads `request.formData()` into memory, which means a
1 GB upload either gets rejected by `MAX_FILE_SIZE`, or — if we'd just bumped
that — OOMs the 3.5 GB App Service instance. Azure's front-end proxy also
caps request bodies independently of our limit.

The fix: browsers PUT directly to Azure Blob Storage with a short-lived,
single-blob-scoped SAS URL. The app never sees the file bytes, only metadata.
RAM stays flat regardless of file size. Multi-GB sessions become trivial.

This PR also stands up the Azure Blob Storage infrastructure that the
upcoming **speaker-labels** feature (see
`docs/plans/2026-05-27-speaker-labels-design.md`) already assumes exists —
same storage account, second container (`voice-samples`) created empty.

## Decisions

| Question | Decision |
| --- | --- |
| Browser → Blob upload mechanism | `@azure/storage-blob` browser SDK with `BlockBlobClient.uploadData()`. Handles multi-block, parallel, progress, retry. |
| App → Blob authentication | Managed identity via `DefaultAzureCredential`. No shared key, no connection string, no secret to rotate. Local dev/CI use an Azurite connection string. |
| Browser → Blob authentication | User-delegation SAS issued by the app, 30 min TTL, scoped to a single blob path, PUT-only. |
| Blob naming | `uploads/{userId}/{timestamp}-{uuid}.{ext}` — user-namespaced so cross-user access is path-impossible even before RBAC. |
| Storage account topology | One shared account; containers `audio-sessions` (this PR) + `voice-samples` (speaker-labels later, created empty here). |
| Existing file handling | One-shot migration script uploads every existing local file to Blob and rewrites `Upload.path` + `storage='blob'`, deletes the local copy on success. |
| Backwards-compat window | `Upload.storage` enum (`local \| blob`) lets the read path tolerate both during the migration window; new rows always `blob`. |
| Max upload size | Default 2 GB (`MAX_FILE_SIZE=2147483648`). Enforced at SAS-issue time (rejects request if `size > limit`) AND re-verified at `/complete` against actual blob size. |
| CORS | Storage account allows `PUT, GET, HEAD, OPTIONS` from app origins (prod hostname + `http://localhost:3000` for dev). 1 h max-age. |
| Smoke test backend | Azurite sidecar in `docker-compose.smoke.yml`. Identical Azure SDK code, connection string differs. |
| Audio retention | Deferred to speaker-labels feature. Schema gets `audioExpiresAt` (nullable) here so the cron there has data to work with; left null in this PR. |
| Failure mode if Blob is unreachable | `/uploads/sas` returns 503 with a clear error. The UI surfaces "Storage temporarily unavailable" instead of silently falling back to local disk (which would be a footgun). |

## Section 1 — API surface

Two new endpoints, replacing the one-shot POST `/api/uploads`:

### `POST /api/uploads/sas`

**Request:**
```json
{
  "originalName": "session-001.m4a",
  "mimetype": "audio/mp4",
  "size": 524288000
}
```

**Response (200):**
```json
{
  "sasUrl": "https://dndrec.blob.core.windows.net/audio-sessions/uploads/user_123/1730000000000-uuid.m4a?sv=...&sig=...",
  "blobPath": "uploads/user_123/1730000000000-uuid.m4a",
  "expiresAt": "2026-05-28T18:14:00Z"
}
```

**Errors:**
- 401 if not signed in
- 400 if `mimetype` not in allow list (same list as today)
- 413 if `size > MAX_FILE_SIZE`
- 503 if user-delegation key can't be obtained from managed identity

The SAS is generated with:
- `BlobSASPermissions.from({ create: true, write: true })` (no `read`, no `delete`)
- Resource scope: single blob (`b`), not container (`c`)
- TTL: 30 min
- Signed with the user-delegation key (no account key involved)

### `POST /api/uploads/complete`

**Request:**
```json
{
  "blobPath": "uploads/user_123/1730000000000-uuid.m4a",
  "originalName": "session-001.m4a",
  "mimetype": "audio/mp4",
  "size": 524288000
}
```

**Response (200):**
```json
{
  "upload": { "id": "...", "filename": "...", "size": 524288000, "duration": 7234, ... }
}
```

**Server-side processing:**
1. Verify signed-in user owns `blobPath` (path starts with `uploads/{userId}/`).
2. HEAD the blob to confirm it exists and read actual size from `Content-Length`.
3. Reject if actual size differs from client-supplied size by more than 1 byte (defense against client lying to bypass the SAS-time check).
4. Stream blob to a temp file at `/tmp/probe-{uuid}.{ext}`, run ffprobe, delete temp file.
5. Insert `Upload` row with `path = blobPath`, `storage = 'blob'`, `duration = probedSeconds`.
6. Return Upload row.

**Errors:**
- 401 if not signed in
- 403 if `blobPath` ownership check fails
- 404 if blob doesn't exist (client never PUT)
- 422 if size mismatch
- 422 if ffprobe fails (unparseable audio — refund the blob, delete it, return error)

## Section 2 — Storage abstraction

```ts
// src/services/storage/types.ts
export type StorageBackend = 'azure-blob' | 'local';

export interface StorageService {
  readonly backend: StorageBackend;

  /** Issue a time-limited upload URL the browser can PUT directly to. */
  issueUploadUrl(opts: {
    userId: string;
    originalName: string;
    mimetype: string;
    size: number;
  }): Promise<{ uploadUrl: string; blobPath: string; expiresAt: Date }>;

  /** Verify a previously-issued upload actually landed. Returns the real size. */
  head(blobPath: string): Promise<{ exists: boolean; size: number }>;

  /** Download to a unique temp path. Caller must delete when done. */
  materializeToTempFile(blobPath: string): Promise<string>;

  /** Permanently delete. Used during deletion + on failed `/complete`. */
  delete(blobPath: string): Promise<void>;
}
```

**Implementations:**

- `AzureBlobStorageService` — production. Uses `BlobServiceClient` constructed
  from `DefaultAzureCredential` + `AZURE_BLOB_ACCOUNT_NAME`. Generates SAS via
  `getUserDelegationKey()` + `generateBlobSASQueryParameters()`.
- `AzuriteStorageService` — local dev + smoke. Identical Azure SDK code,
  constructed from `AZURE_STORAGE_CONNECTION_STRING` (Azurite's well-known
  connection string). Same SAS code path — Azurite supports user-delegation
  SAS as of 3.x.
- `LocalDiskStorageService` — fallback for environments without either of
  the above. Maintains the existing `./uploads/{filename}` behaviour and
  proxies "uploads" through a server-side endpoint instead of issuing real
  SAS URLs. Returns `uploadUrl = /api/uploads/local-passthrough/{token}`.
  Kept ONLY so unit tests + ad-hoc `npm run dev` without Docker still work.
  Production must use one of the Blob backends.

**Selection logic** (`src/services/storage/index.ts`):
```ts
if (process.env.AZURE_BLOB_ACCOUNT_NAME) return new AzureBlobStorageService();
if (process.env.AZURE_STORAGE_CONNECTION_STRING) return new AzuriteStorageService();
return new LocalDiskStorageService();
```

Logged once at boot: `[storage] backend=<azure-blob|azurite|local>`.

## Section 3 — Consumer integration

Every existing consumer that reads `Upload.path` as a local file needs to
call a new helper instead:

```ts
// src/services/storage/materialize.ts
export async function withMaterializedAudio<T>(
  upload: { path: string; storage: 'local' | 'blob' },
  fn: (localPath: string) => Promise<T>,
): Promise<T> {
  if (upload.storage === 'local') {
    return fn(upload.path); // already a local path
  }
  const tempPath = await getStorageService().materializeToTempFile(upload.path);
  try {
    return await fn(tempPath);
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}
```

**Call sites to convert:**
- `src/services/ai/openai.ts` — `OpenAITranscriptionService.transcribe`
- `src/services/ai/google.ts` — `GoogleTranscriptionService.transcribe`
- `src/services/ai/whisperLocal.ts` — `LocalWhisperTranscriptionService.transcribe`
- `src/services/ai/mock.ts` — `MockTranscriptionService.transcribe` (just needs path validation)
- Any route that passes `upload.path` to ffprobe / fluent-ffmpeg

Strategy: change `TranscriptionService.transcribe(audioPath: string)` callers
to pass `upload` (the row) rather than the raw path, and have each service
wrap its body in `withMaterializedAudio`. The service interface signature
stays the same (`transcribe(audioPath: string)`) — the wrap happens in the
route layer just above the service call.

The `splitAudioBySize` helper in `audioChunker.ts` continues to operate on a
local path; it just gets handed the materialized temp path instead of the
original.

## Section 4 — Schema change

Single Prisma migration:

```prisma
enum UploadStorage {
  local
  blob
}

model Upload {
  // ... existing fields
  storage         UploadStorage  @default(blob)
  audioExpiresAt  DateTime?      @map("audio_expires_at")
}
```

`audioExpiresAt` lives here but is unused in this PR — speaker-labels will
populate + purge against it. Kept here so we don't need a second migration
for one column.

Default `blob` is correct for any row inserted AFTER the migration runs.
Existing rows are pre-migration so they have `storage = 'local'` (Prisma
default applies only to inserts, not backfill — we add an explicit
`UPDATE Upload SET storage = 'local' WHERE created_at < NOW()` to the same
migration to make the rollout window safe).

The follow-up migration script (Section 5) then walks those rows and flips
them to `blob` one by one as files move.

## Section 5 — Migration script

`scripts/migrate-uploads-to-blob.ts`:

1. Load env. Refuse to run if `AZURE_BLOB_ACCOUNT_NAME` is not set (we will
   NOT migrate to Azurite — that would be a data-loss footgun on prod).
2. Query `SELECT * FROM "Upload" WHERE storage = 'local'`.
3. For each row, in serial (no concurrency — keep RAM flat):
   a. `fs.statSync(row.path)`. If file missing, log + skip (orphaned DB row).
   b. Generate the new blob path: `uploads/{userId}/{row.filename}` (keep the
      existing `{timestamp}-{uuid}` naming inside `filename` — no rewrite).
   c. Stream-upload to Blob via `BlockBlobClient.uploadFile()`.
   d. HEAD the blob, verify size matches.
   e. Transaction: `UPDATE Upload SET path = $blobPath, storage = 'blob' WHERE id = $id`.
   f. `fs.unlinkSync(row.path)`.
4. Print summary: `Migrated N, skipped M (missing), failed K`.

The script is idempotent — only operates on rows still marked `'local'`, and
re-runs cleanly if interrupted halfway through.

Triggered manually post-deploy via:
```bash
docker exec <container> node /app/scripts/migrate-uploads-to-blob.js
```

(Not run automatically on boot — we want explicit human-in-the-loop control
the first time.)

After verification, a follow-up PR can drop the `'local'` enum variant and
the `LocalDiskStorageService` (or keep them for dev convenience).

## Section 6 — Frontend changes

`src/app/sessions/upload/page.tsx` and `src/app/sessions/[id]/page.tsx`
(both have upload forms) change as follows.

**Before** (single multipart POST):
```ts
const formData = new FormData();
formData.append('audio', file);
const resp = await fetch('/api/uploads', { method: 'POST', body: formData });
```

**After** (three-step):
```ts
import { BlockBlobClient, AnonymousCredential } from '@azure/storage-blob';

// 1. Get SAS
const sasResp = await fetch('/api/uploads/sas', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    originalName: file.name,
    mimetype: file.type,
    size: file.size,
  }),
});
if (!sasResp.ok) throw new Error(await sasResp.text());
const { sasUrl, blobPath } = await sasResp.json();

// 2. Upload directly to Blob with progress
const client = new BlockBlobClient(sasUrl, new AnonymousCredential());
await client.uploadData(file, {
  blockSize: 4 * 1024 * 1024,           // 4 MB blocks
  concurrency: 4,                        // 4 parallel block uploads
  onProgress: ({ loadedBytes }) => setProgress(loadedBytes / file.size),
});

// 3. Notify app
const completeResp = await fetch('/api/uploads/complete', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    blobPath,
    originalName: file.name,
    mimetype: file.type,
    size: file.size,
  }),
});
if (!completeResp.ok) throw new Error(await completeResp.text());
const { upload } = await completeResp.json();
```

Real progress reporting is now possible (the existing UI fakes it with a
spinner). Replace the spinner with a `<progress>` bar driven by `onProgress`.

**On failure mid-upload:** `uploadData` retries automatically. If it
ultimately fails, we POST nothing to `/complete` and the orphaned blob ages
out via a Blob lifecycle rule (added in deploy repo: "delete blobs older than
7 days under `uploads/` with no `committed` metadata tag"). For V1 we skip
the lifecycle rule and accept some orphan blobs — cleanup is a follow-up.

## Section 7 — Infrastructure (deploy repo)

Changes go in `Domo929/dnd-recorder-deploy`:

- New Bicep module `infra/modules/storage.bicep`:
  - Storage account (StorageV2, hot tier, LRS, soft-delete 7 d for blobs and containers, public-blob-access **disabled**).
  - Two containers: `audio-sessions` (private), `voice-samples` (private).
  - CORS rules: `PUT, GET, HEAD, OPTIONS` from `https://<app-hostname>` and `http://localhost:3000`.
  - Role assignment: App Service system-assigned managed identity gets `Storage Blob Data Contributor` on the storage account.
- New env vars wired into App Service settings:
  - `AZURE_BLOB_ACCOUNT_NAME=<storage-account-name>`
  - `AZURE_BLOB_AUDIO_CONTAINER=audio-sessions`
  - `AZURE_BLOB_VOICE_CONTAINER=voice-samples` (for speaker-labels)
  - `MAX_FILE_SIZE=2147483648` (2 GB)
- App Service system-assigned identity enabled (if not already).

CORS is the most likely thing to bite us in prod — the SDK does a preflight
OPTIONS before every PUT, and a misconfigured CORS rule presents as "uploads
just hang" with no useful error in the app logs (the failure is browser-side).
Smoke test against Azurite validates the SDK call shape but NOT the CORS
config — so a manual post-deploy "upload a 50 MB file" verification step
goes into the deploy runbook.

## Section 8 — Smoke + tests

**Azurite in smoke compose:**

```yaml
services:
  azurite:
    image: mcr.microsoft.com/azure-storage/azurite:latest
    command: azurite-blob --blobHost 0.0.0.0 --skipApiVersionCheck
    ports: []  # no host port; app talks via network
    healthcheck:
      test: ["CMD", "nc", "-z", "localhost", "10000"]
      interval: 5s
      timeout: 3s
      retries: 5

  dnd-recorder:
    environment:
      - AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://azurite:10000/devstoreaccount1;
    depends_on:
      azurite:
        condition: service_healthy
```

The app's `AzuriteStorageService` constructs `BlobServiceClient` from that
connection string and ensures the `audio-sessions` container exists on boot
(`createIfNotExists`).

The Playwright spec stays at the UI layer — `setInputFiles` + click submit
— so the test is genuinely end-to-end across the new SAS flow. The existing
"upload silence.wav → expect Session Created" assertion is unchanged.

**Unit tests added:**
- `src/services/storage/__tests__/azure.test.ts` — round-trip against Azurite
  (issueUploadUrl → PUT via SDK → head → materialize → delete).
- `src/app/api/uploads/__tests__/sas-and-complete.test.ts` — auth gating,
  mime validation, ownership check, size mismatch detection.
- `scripts/migrate-uploads-to-blob.test.ts` — synthetic Upload rows + temp
  files, asserts script idempotency and missing-file handling.

## Section 9 — Rollout sequence

1. Ship infra changes (deploy repo): storage account + containers + RBAC + CORS + env vars. App still works (it doesn't read the new env vars yet).
2. Merge this app PR. New uploads go to Blob. Existing rows still marked `'local'`, served from local disk via `LocalDiskStorageService` fallback (covered by Section 2 selection logic + Section 3 `withMaterializedAudio`).
3. Run `node scripts/migrate-uploads-to-blob.js` manually inside the App Service container. Verify final summary line.
4. Manual verification: upload a 50 MB file end-to-end. (CORS smoke.)
5. Optional follow-up PR: drop `LocalDiskStorageService` + `'local'` enum variant once we're confident no rows remain.

## What's deferred

- **14d retention cron** — schema field added, but the daily purge job lives with the speaker-labels feature.
- **Orphan-blob cleanup** — uploads that fail mid-`uploadData` leave blobs in the container. Deferred to a Blob lifecycle rule (7 d age-out under `uploads/`) added in a follow-up.
- **Resumable uploads across browser refresh** — `uploadData` resumes within a session via block IDs, but the block list is in-memory only. Tab close = restart. Could be added via `localStorage`-persisted block lists; not in V1.
- **Server-side virus scan** — direct uploads bypass any "server inspects the bytes" hook. Not needed today (it's the DM's own audio of their own session), but worth a note for the future.

## Open questions

None blocking. To revisit when this is in prod:
- Does the Azure region matter for upload latency from US-central users? (Likely no — Blob is close to the App Service.)
- Is 4 MB block size optimal? Default works, but for very large files larger blocks reduce overhead. Tunable later if it shows up in metrics.
