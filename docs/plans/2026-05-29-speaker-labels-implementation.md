# Speaker labels — implementation plan

Executes `docs/plans/2026-05-27-speaker-labels-design.md` (approved). Built in
verifiable vertical slices; each slice is its own PR into `main` (fork-only).
Phases that require live Azure GPU/ACI or the GPU container image can't be
end-to-end verified in this environment, so their app-side logic is built +
unit-tested here and wired to infra later (deploy repo `Domo929/dnd-recorder-deploy`).

Reminders: Node 22 for all npm/prisma (`source ~/.nvm/nvm.sh && nvm use 22`).
Never commit compiled `.js`/`.d.ts` next to `.ts` in `src/`. Co-author trailer on
commits. Verify migrations replay on a throwaway Postgres.

## SL-1 — Data model  (this PR)

Additive Prisma changes on the aligned schema (design Section 1):
- Enums: `TranscriptionMode`, `DiarizationStatus`, `InferenceStatus`,
  `VoiceSampleSource`.
- `Campaign`: `defaultTranscriptionMode`, `diarizationEnabled`,
  `npcInferenceEnabled` + `speakerClusters` relation.
- `Member`: `voiceSamples` relation.
- `GamingSession`: `transcriptionMode`, `diarizationStatus`,
  `npcInferenceStatus`, `needsResummarize` + relations.
- `Transcription`: nullable `speakerClusterId` (+ index) — extend, no new table.
- New models: `VoiceSample`, `SessionSpeakerCluster`, `DiarizationJob`,
  `SessionNpcSuggestion`.
- Migration + `db.ts` types/method stubs only as needed to keep tsc green.
- Verify: `prisma validate`, migration replay on throwaway PG, `tsc`, `vitest`,
  `next build`.

## SL-2 — Embedding + matching helpers

- `onnxruntime-node` + bundled ECAPA-TDNN ONNX model (192-dim). Embedding service
  with a clear interface; cosine-similarity + embedding (de)serialization
  (`Float32Array` <-> `Bytes`) helpers. `voice-samples` blob helpers reuse the
  storage abstraction (`AZURE_BLOB_VOICE_CONTAINER`).
- Unit tests: cosine math, serialization round-trip, matching threshold logic
  (mock the ONNX session — no real model needed in CI).
- **Self-refining fingerprints** (design: `2026-05-29-self-refining-fingerprints-design.md`):
  scoring = `max(cosine)` over a voice's `VoiceExemplar`s; campaign-best voice
  vs `MATCH_THRESHOLD` (0.65); **person-level fallback** = max over a member's
  voices vs `PERSON_FALLBACK_THRESHOLD` (0.55) → low-confidence attribution to
  closest voice; learn-gate helper (`shouldLearn`: dm_confirmed OR score ≥
  `LEARN_THRESHOLD` 0.80) and add-exemplar-with-eviction helper (cap
  `MAX_EXEMPLARS_PER_VOICE` 10, never evict `pinned`, drop oldest unpinned).
  All pure functions, unit-tested with synthetic embeddings.

## SL-3 — Voice enrollment (Voice Library)

- API: list/create/delete `VoiceSample` (SAS for clip upload reuses
  `/api/uploads/sas` pattern scoped to the voice container; embed-on-complete).
- UI: per-member Voice Library page, `MediaRecorder` capture (15s target,
  8–60s bounds), play/delete, labels, auto-promoted badge.
- Per-upload mode toggle on the create-session form (design Section 6), disabled
  when the campaign has zero voice samples.

## SL-4 — Diarization pipeline (app side)

- `DiarizationJob` lifecycle: queue on transcription-complete when
  `speaker_labeled` + ≥1 voice sample. In-app dispatcher (`setInterval` 30s),
  daily budget (fail-closed + override), per-job HMAC, read-only audio SAS,
  ACI ARM create across `DIARIZATION_REGIONS`. Cleanup loop (60s).
- Callback `POST /api/diarization/callback/[jobId]`: HMAC verify, upsert clusters
  + `Transcription` rows, run matching (Section 3) + lazy-tag cascade, snippets.
- **Learning on resolve:** after matching, for high-confidence/DM-confirmed
  clusters call the SL-2 add-exemplar helper to fold the cluster centroid into
  the voice's fingerprint (idempotent by `sourceSessionId`); set
  `matchConfidence`/`matchedScore` per Section 2 of the fingerprints design.
- Unit tests for HMAC, budget, region fallthrough, matching cascade, learning.

## SL-5 — Speaker-aware transcript + summary + NPC inference

- Transcript view grouping consecutive same-cluster turns; "Tag voice"
  affordance. Speaker-roster summary prompt via existing `generateAiText`.
  NPC inference pass -> `SessionNpcSuggestion`. Cost-aware re-summarize dialog
  (`estimateSummaryCost`).

## SL-6 — Cron + retention

- Audio retention purge (daily 03:00 UTC vs `Upload.audioExpiresAt`), set
  `audioExpiresAt` on speaker-labeled link/complete. Unknown-snippet purge
  (daily 03:15 UTC). ACI cleanup already in SL-4.

## SL-7 — GPU container  (separate, infra)

- `docker/diarization/` (pyannote 3.1 + whisper word-ts + ECAPA centroids),
  GHCR image. Deploy-repo infra: `voice-samples` container, ACI RBAC, env vars.
  Not verifiable locally.
