# Speaker Relabeling & Voice Training — Design (Ticket #6)

Date: 2026-05-29

## Problem

In **basic transcription mode**, Gemini emits inline text labels (`Speaker 1:`,
`Speaker 2:`) with no timestamps and no audio fingerprints. The labels are
unreliable — the same `Speaker N` is reused for different people. Users cannot:

1. Correct/assign real names to speakers in a basic-mode transcript.
2. Keep those names consistent across a campaign (e.g. avoid `bruce` vs `Bruce`).
3. Use their corrections to train/improve voice recognition.

The app already has a complete **diarization-mode** pipeline (real
`SessionSpeakerCluster` rows with 192-dim embeddings, a tag→learn→cascade flow,
NPC suggestions). The gap is (a) basic-mode has no tagging at all, and (b) there
is no on-demand bridge from a basic session into the diarized/training pipeline.

## Hard technical constraints

- **Basic-mode transcripts are a single `Transcription` row** with
  `startTime: 0, endTime: 0` — one text blob, speaker labels inline. No per-turn
  timestamps exist.
- **Voice training requires per-speaker audio**, which only a diarization run
  produces. Therefore training is **impossible from basic-mode text alone**; the
  session must be diarized first.
- Because basic-mode turns have no timestamps, we **cannot auto-map** diarized
  clusters back to the exact turns a user named. Track-A names instead surface as
  autocomplete suggestions (they live in the shared campaign registry).
- **Audio retention:** the purge cron (`/api/cron/audio-retention`, daily ~03:00
  UTC) only deletes uploads whose `audioExpiresAt < now`. A fresh upload has
  `audioExpiresAt = null` (kept indefinitely); the clock is set **only when
  diarization completes** (`now + AUDIO_RETENTION_DAYS`, default now 28 days).
  So basic-mode audio is retained indefinitely — the basic→diarized bridge will
  almost always have audio available. Re-upload is only needed for sessions
  diarized > retention-window days ago.

## Solution: two tracks, two PRs

### Track A (PR 1) — Basic-mode speaker relabeling (text only)

Net-new, ships independently, no AI/GPU cost.

**Data model — two small tables:**

```prisma
model SessionSpeakerDefault {
  id             String   @id @default(cuid())
  sessionId      String   @map("session_id")
  campaignId     String   @map("campaign_id") // denormalized for registry queries
  speakerKey     String   @map("speaker_key") // "Speaker 1"
  name           String
  normalizedName String   @map("normalized_name")
  createdAt      DateTime @default(now()) @map("created_at")
  session        GamingSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  @@unique([sessionId, speakerKey])
  @@index([campaignId])
  @@map("session_speaker_defaults")
}

model SessionSpeakerTurn {
  id             String   @id @default(cuid())
  sessionId      String   @map("session_id")
  campaignId     String   @map("campaign_id")
  turnIndex      Int      @map("turn_index") // position in the parsed turn list
  name           String
  normalizedName String   @map("normalized_name")
  createdAt      DateTime @default(now()) @map("created_at")
  session        GamingSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  @@unique([sessionId, turnIndex])
  @@index([campaignId])
  @@map("session_speaker_turns")
}
```

**Turn detection:** reuse PR #33's `src/lib/transcriptFormat.ts` parser to split
the basic-mode blob into an ordered list of turns `{ turnIndex, speakerKey, text }`.
Turn indices are stable because storage is non-destructive.

**Name resolution (per turn):**
`turnOverride[turnIndex]?.name ?? speakerDefault[speakerKey]?.name ?? speakerKey`

Two layers: a per-speaker-key **default** (bulk: "all Speaker 1 → Bruce") plus
per-turn **overrides** (authoritative; handles "Speaker 1 is usually Bruce but
sometimes Alice").

**Non-destructive:** the stored transcript text keeps `Speaker N`. Names are
applied at render time (transcript view) and injected into the summary prompt
(rewriting `Speaker N:` prefixes to the resolved name). Relabeling sets
`needsResummarize = true` and offers a re-summarize action (existing mechanism).

**Virtual campaign registry (a query, not a table):** union of
- `VoiceSample.label` (enrolled voices),
- campaign member / player display names,
- accepted `SessionNpcSuggestion.suggestedName`,
- `DISTINCT` names across `SessionSpeakerDefault` + `SessionSpeakerTurn` in the
  campaign (this is what makes a new relabel reusable for future sessions).

**Fuzzy matching** (`src/lib/speakerNameMatch.ts`, pure TS, no deps): normalize
(lowercase/trim/collapse whitespace), exact-normalized match first, then a
Dice-coefficient (bigram) similarity for near matches above a threshold. On
assign, surface the canonical existing name as the top suggestion so the user
snaps to it instead of forking a duplicate casing.

**API:**
- `GET /api/sessions/[id]/speaker-labels` → `{ defaults: [...], turns: [...] }`.
- `PUT /api/sessions/[id]/speaker-labels` → upsert defaults and/or turn overrides
  (owner-only; flags `needsResummarize`).
- `GET /api/campaigns/[id]/speaker-registry` → the registry union for autocomplete.

**UI** (extend `src/app/sessions/[id]/components/transcript-section.tsx` for
basic mode):
- Each turn shows a speaker chip (`Speaker 1 ▾`) → inline name field with
  registry autocomplete; overridden turns visually marked.
- A header control to set/clear per-speaker-key defaults.
- A "Re-summarize with names" affordance when labels changed.

**Tests:** unit tests for `speakerNameMatch` (normalization, dice, dedupe,
canonical-casing pick) and turn resolution; route tests for the two API routes
mirroring existing vitest patterns.

### Track B (PR 2) — Training via diarization (the bridge)

Builds on the existing diarization/cluster pipeline.

**Basic → diarized bridge:**
- `POST /api/sessions/[id]/diarize` — owner-only on-demand trigger. Guards: audio
  present (`Upload` not purged), not already `queued`/`running`. Sets
  `transcriptionMode = speaker_labeled`, enqueues a `DiarizationJob` via the
  existing dispatcher. Produces real clusters with fingerprints; existing
  callback matches them against enrolled voices.
- `POST /api/sessions/[id]/reupload-audio` — when audio was purged, attach a new
  audio file via the existing blob/SAS pipeline (`createUploadFromBlob`), point
  `session.uploadId` at it, then allow `diarize`. The user is trusted to upload
  the same recording (no verification possible).

**Training controls (extend the existing diarized speaker UI
`speaker-transcript-section.tsx`):**
- Per-cluster **"use for training"** toggle: controls whether tagging that
  cluster writes a `dm_confirmed` `VoiceExemplar` (so a noisy/short cluster need
  not pollute a voice fingerprint). Extend `POST /api/clusters/[id]/tag` with an
  optional `useForTraining` boolean (default true to preserve current behavior).
- **"Re-run matching"** button: `POST /api/sessions/[id]/rematch` — a
  session-scoped, on-demand version of the existing cascade in
  `tagClusterWithNewName`: re-score all still-unknown clusters in this session
  against current campaign voices (seed + exemplars), auto-link matches above
  threshold, flag affected sessions for re-summarize. Lets the user "label a
  couple, then apply learning to the rest" manually.
- Track-A names appear as top autocomplete suggestions during cluster tagging via
  the shared registry (no fragile time-mapping).

**Edge cases:**
- Re-transcribing a session invalidates turn indices → clear `SessionSpeakerTurn`
  / `SessionSpeakerDefault` on a fresh (non-resume) transcription run.
- Concurrency: reuse the existing claim-on-update (`updateMany where voiceSampleId
  is null`) pattern for tag/rematch.
- `rematch` is idempotent (exemplar uniqueness on `[voiceSampleId, sourceSessionId]`).

**Tests:** route tests for `diarize`, `reupload-audio`, `rematch`, and the
`useForTraining` branch of the tag route; unit test for the session-scoped
rematch scoring.

## Out of scope (YAGNI)
- Auto time-aligning basic-mode turns to clusters (no timestamps; not feasible).
- A persistent campaign-speaker registry table (the virtual query suffices).
- Verifying a re-uploaded file matches the original recording.

## Prerequisite (separate, already in flight)
- PR: default `AUDIO_RETENTION_DAYS` 14 → 28 (gives a longer window before a
  diarized session's audio is purged). Independent of Tracks A/B.

## Rollout order
1. Retention 28d (separate PR) — done/in-flight.
2. PR 1 — Track A (basic-mode relabeling). Shippable alone; immediate value.
3. PR 2 — Track B (diarize bridge + re-upload + training toggle + re-run match).
