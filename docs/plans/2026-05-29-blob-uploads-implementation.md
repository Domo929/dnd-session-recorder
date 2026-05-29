# Direct-to-Blob Uploads — Implementation Plan

> **For the implementer:** Execute task-by-task, TDD, commit after each green task.
> Full design + decisions: `docs/plans/2026-05-28-direct-to-blob-uploads-design.md`.

**Goal:** Move session-audio uploads off the app server — browsers PUT directly to
Azure Blob with a short-lived SAS URL; the app only handles metadata. Lifts the
upload ceiling from ~100 MB to 2 GB and keeps RAM flat.

**Architecture:** A `StorageService` abstraction (`azure-blob` | `azurite` |
`local`) issues upload URLs, HEADs/ materializes/ deletes blobs. Upload routes
become a two-step SAS handshake (`/api/uploads/sas` then `/complete` or the
refactored `create-with-upload`). Consumers that treat `Upload.path` as a local
file run through `withMaterializedAudio()`. A nullable `Upload.storage` enum lets
old `local` rows coexist during migration.

**Tech stack:** Next.js 15 (App Router), Prisma + Postgres, `@azure/storage-blob`,
vitest (pure unit tests, no live DB), TypeScript.

**Repo facts that shaped this plan:**
- Tests are pure unit tests under `src/**/__tests__/`, node env, **no live DB** and
  mock-heavy. New tests must not require Azurite/docker to run under `npm test`.
- Three upload routes read `request.formData()` + `writeFile`: `POST /api/uploads`,
  `POST /api/sessions/create-with-upload`, `POST /api/sessions/[id]/upload`.
- Materialization hot path: `src/app/api/transcription/[sessionId]/route.ts`
  (`session.upload.path` → `splitAudioBySize` → `fs.readFileSync` →
  `transcribeAudio(Buffer)`). `src/lib/ai.ts` is **unchanged** (buffer-based).
- `db.createUpload(data)` ignores any `storage` field today — must be extended.
- Smoke infra (`docker-compose.smoke.yml`, `scripts/smoke.sh`, `tests/e2e/`) does
  **not** exist on the aligned `main` — design Section 8 smoke wiring is therefore
  out of scope here (tracked as a follow-up, not a blocker).
- Infra (design Section 7: Bicep, storage account, CORS, RBAC, env vars) lives in
  the separate `Domo929/dnd-recorder-deploy` repo — done after the app code.

---

## Task 1 — Dependency + schema migration  (`blob-deps-schema`)

**Files:**
- Modify: `package.json` (add `@azure/storage-blob`)
- Modify: `prisma/schema.prisma` (Upload model + enum)
- Create: `prisma/migrations/<ts>_add_upload_storage/migration.sql`

**Steps:**
1. `npm install @azure/storage-blob` (Node 22).
2. Add to schema:
   ```prisma
   enum UploadStorage { local  blob }
   ```
   In `model Upload`: `storage UploadStorage @default(blob)` and
   `audioExpiresAt DateTime? @map("audio_expires_at")`.
3. Generate migration against local Postgres: `npm run db:up && sleep 3 &&
   npx prisma migrate dev --name add_upload_storage`. Then **append** a backfill so
   pre-existing rows are correct (Prisma `@default` only applies to inserts):
   `UPDATE "uploads" SET storage = 'local' WHERE created_at < NOW();`
4. Verify: `npx prisma validate` + `npx prisma migrate status` → "up to date".
5. Commit: `chore(db): add Upload.storage enum + audioExpiresAt`.

## Task 2 — Storage service abstraction  (`blob-storage-svc`)

**Files:**
- Create: `src/services/storage/types.ts` (StorageBackend, StorageService iface — per design Section 2)
- Create: `src/services/storage/local.ts` (LocalDiskStorageService)
- Create: `src/services/storage/azure.ts` (AzureBlobStorageService — DefaultAzureCredential, user-delegation SAS)
- Create: `src/services/storage/azurite.ts` (AzuriteStorageService — connection string; may subclass/share azure.ts)
- Create: `src/services/storage/index.ts` (`getStorageService()` singleton + boot log; selection per design Section 2)
- Create: `src/services/storage/materialize.ts` (`withMaterializedAudio`)
- Create: `src/services/storage/__tests__/storage.test.ts`

**Test-first:** selection logic (env → backend) and `LocalDiskStorageService`
(`issueUploadUrl` returns a passthrough URL + namespaced blobPath; `head` reflects
fs; `materializeToTempFile`/`delete`). Mock `fs` or use a temp dir. Azure/Azurite
round-trip is NOT unit-tested (needs a container) — keep those classes thin and
delegate to the SDK so the untested surface is minimal.

Steps per class: write failing test → run (`npm test -- storage`) → implement →
green → commit.

## Task 3 — Shared helper + SAS/complete routes  (`blob-helper-routes`)

**Files:**
- Modify: `src/services/database.ts:432` `createUpload` — accept + persist `storage`
  (default `'blob'`) and optional `audioExpiresAt`; extend `CreateUploadData`.
- Create: `src/services/storage/createUploadFromBlob.ts` — shared steps 1-5
  (ownership check `blobPath` startsWith `uploads/{userId}/`; `head` real size;
  size-mismatch 422; `withMaterializedAudio` → ffprobe `getAudioDuration`; insert
  Upload; on probe failure delete blob + throw). Reuse the existing allowed-mime list.
- Create: `src/app/api/uploads/sas/route.ts` (POST) — auth, mime allow-list (400),
  `size > MAX_FILE_SIZE` (413), `issueUploadUrl` (503 on key failure).
- Create: `src/app/api/uploads/complete/route.ts` (POST) — calls helper; maps errors
  to 401/403/404/422.
- Create: `src/app/api/uploads/__tests__/sas-and-complete.test.ts` — mock
  `requireAuth`, `getStorageService`, `db`; cover auth gating, mime, size limit,
  ownership, size-mismatch.

TDD per route. Commit after each green route.

## Task 4 — Refactor existing upload routes  (`blob-refactor-routes`)

**Files:**
- Modify: `src/app/api/sessions/create-with-upload/route.ts` — JSON body with
  `blobPath/originalName/mimetype/size` instead of multipart `audio`; mint Upload via
  `createUploadFromBlob`; keep create-session + fire-and-forget process + 207 path.
- Modify: `src/app/api/sessions/[id]/upload/route.ts` — same File→blobPath swap.
- Modify: `src/app/api/uploads/route.ts` POST — either delegate to the helper or mark
  deprecated in favor of sas+complete (keep GET reconciliation; make it
  `storage`-aware: blob rows reconcile via `head().exists`).
- `npm test`, `npm run typecheck` green. Commit.

## Task 5 — Consumer integration  (`blob-consumers`)

**Files:**
- Modify: `src/app/api/transcription/[sessionId]/route.ts:104-234` — wrap the
  split→loop→cleanup body in `withMaterializedAudio(session.upload, async (localPath)
  => {...})`; replace `fs.existsSync(fullPath)` reconcile branch with
  `getStorageService().head(...).exists === false` for blob rows (keep fs check for
  local). `transcribeAudio(Buffer)` unchanged.
- Modify: `src/services/fileCleanup.ts` — for `storage='blob'` uploads, delete via
  `getStorageService().delete(blobPath)`; local chunk temp files still via
  `cleanupChunkFiles`.
- `npm test`, `npm run typecheck`, `npm run build` green. Commit.

## Task 6 — Migration script  (`blob-migrate-script`)

**Files:**
- Create: `scripts/migrate-uploads-to-blob.ts` (design Section 5 — serial, idempotent,
  refuses to run without `AZURE_BLOB_ACCOUNT_NAME`, skips missing files).
- Create: `scripts/__tests__/migrate-uploads-to-blob.test.ts` — synthetic rows + temp
  files via mocks; idempotency + missing-file handling. (Put under a path vitest
  includes, or add the script dir to vitest `include`.)
- Commit.

## Task 7 — Frontend  (`blob-frontend`)

**Files:**
- Modify: `src/app/sessions/upload/page.tsx` — three-step flow (SAS → `uploadData` with
  `onProgress` → JSON `create-with-upload`); replace spinner with `<progress>`.
- Modify: `src/app/uploads/page.tsx` — standalone path via `/api/uploads/sas` +
  `/api/uploads/complete`.
- `npm run build` green. Commit.

## Task 8 — Verify  (`blob-verify`)

Run `npm run typecheck && npm run lint && npm test && npm run build`. All green.
Open PR `feat/blob-uploads` → `main` (fork-only; NOT an upstream PR).

## Deferred (follow-ups, not this branch)
- Infra in `Domo929/dnd-recorder-deploy` (Section 7): storage account, 2 containers,
  CORS, managed-identity RBAC, App Service env vars. Required before prod use.
- Smoke/Azurite wiring (Section 8): smoke infra files don't exist on aligned main.
- 14 d retention cron + orphan-blob lifecycle rule (Section: What's deferred).
- Drop `LocalDiskStorageService` + `'local'` enum after prod backfill completes.
