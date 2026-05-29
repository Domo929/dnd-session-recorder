# Speaker labels — design

**Date:** 2026-05-27 (rewritten 2026-05-29 against the upstream-aligned base)
**Status:** Approved, ready for implementation
**Author:** brainstormed with Copilot CLI

> Rewritten in Phase D after re-founding the fork on `upstream/staging`. The
> design **intent** is unchanged; the data model and integration points are
> re-derived against the aligned schema (`GamingSession`, the segment-level
> `Transcription` model, the campaign-sharing `Member` model) and the aligned
> AI layer (`src/lib/ai.ts`: `transcribeAudio(Buffer)` / `generateAiText`).
> Session audio lives in the `Upload` model (see the blob-uploads design), not a
> bespoke field. See `files/upstream-alignment-master-plan.md` Phase D.

### What changed in this rewrite (vs the pre-alignment draft)

- `Session` → **`GamingSession`** everywhere (the bare `Session` model is
  NextAuth login tokens).
- The old "single `Session.transcript` text blob" assumption is gone. The
  aligned schema **already stores time-segmented `Transcription` rows**
  (`startTime`/`endTime`/`text`/`confidence`) via `db.saveTranscriptions()`. We
  therefore **extend `Transcription`** with a nullable speaker-cluster link
  instead of inventing a parallel `TranscriptSegment` table.
- The provider abstraction is `src/lib/ai.ts`, not `src/services/ai/*`. There
  is no `TranscriptionService.transcribe(audioPath)` class — there is
  `transcribeAudio(audio: Buffer)`. **Crucially, none of the three current
  providers emit word timestamps.** So speaker-labeled mode does NOT extend the
  app's transcription provider; instead the **GPU container produces the
  word-timestamped, speaker-attributed segments directly** (pyannote +
  whisper-with-word-timestamps in one pass). Basic mode keeps using
  `transcribeAudio` untouched. This resolves the word-timestamp gap cleanly.
- Speaker-aware summary is just a different prompt handed to the existing
  `generateAiText(prompt, 'summary')` — no new summary service.
- Session-audio storage + 14 d retention hang off **`Upload`** (`Upload.path` +
  `Upload.storage` + `Upload.audioExpiresAt` from the blob-uploads design), not
  a `GamingSession.audioBlobPath` field.

## Goal

Turn the current "wall-of-text" transcripts into speaker-labeled transcripts
that identify **who** said **what** for every utterance — players by their
character names, the DM by their narrator voice, and recurring NPCs by the
voices the DM gives them.

Input is a **single-microphone mixed recording** (everyone in the room sharing
one mic), the hardest acoustic case — it dictates most of the architecture
(real diarization required, not channel separation).

The feature is opt-in **per upload**: a DM runs cheap basic transcription for
filler sessions and the full speaker-labeled pipeline only when it matters.

## Decisions

| Question | Decision |
| --- | --- |
| Compute path for diarization | On-demand Azure Container Instance with a T4 GPU per session. App stays on the B2 plan. |
| Diarization + transcription model | `pyannote.audio` 3.1 diarization **plus** whisper word-level transcription, run together in the GPU container so output is already speaker-attributed with word timestamps. |
| Voice embedding model | SpeechBrain ECAPA-TDNN, ONNX-exported, bundled in the app image. 192-dim float32. Same model inline (enrollment) and inside the container (per-cluster centroid). |
| Audio storage | Azure Blob (from the blob-uploads design). Session audio = the linked `Upload` blob; enrollment & promoted clips in `voice-samples/{userId}/{sampleId}.opus`. |
| Session audio retention | 14 days, daily cron purge against `Upload.audioExpiresAt`. After purge, re-processing a session is no longer possible (transcripts/segments/summaries are kept). |
| Enrollment / NPC clip retention | Forever, deletable by the owner via "delete this voice". |
| Unknown-cluster snippet retention | 30 days (time for the DM to tag); promoted to permanent when tagged. |
| Per-upload mode | `basic` (current behaviour) vs `speaker_labeled`. Per-campaign default, overridable per upload. |
| Voice samples per member | Unlimited. Each labeled (`Thorin`, `Thorin (drunk)`, `Skritch the goblin`, `Narrator`). Each its own row; no "primary" flag. |
| Transcript display for variant voices | Show each sample's full label distinctly (`Thorin` vs `Thorin (drunk)`); don't collapse. |
| DM fallback rule | Clusters matching no enrolled voice → `DM (Unknown #N)`, surfaced with a playable snippet for lazy tagging. (DM enrolls one "narrator" voice; anything not matching a player or the DM's narrator is assumed DM and tagged later.) |
| NPC inference | LLM post-pass produces suggestions; DM must accept/reject. Never auto-apply. |
| Re-summarize cost transparency | Confirm dialog shows estimated cost from the **currently configured** summary provider/model (the `AI_SUMMARY_PROVIDER` + model from `src/lib/ai.ts`). |
| Spend guardrail | Daily GPU spend cap (env, default $5/day). **Fail closed** when hit, with a per-session "override and run anyway" button. |
| ACI region preference | `centralus,westus2,eastus2`, tried in order. We're in US-central, so we'd prefer Central; T4 isn't published there yet, so it falls through to West US 2. Central stays first for the day MS adds T4 there. |
| Failure handling | ACI failures retried 3× with backoff. After 3, surface a "Retry diarization" button. |
| Callback security | Per-job 32-byte HMAC secret signs the result POST so a leaked URL from one session can't replay against another. |
| Tag cascade | Tagging an unknown cluster creates a `VoiceSample`, then searches every other unknown cluster across all sessions in the campaign for a similarity match, flagging affected sessions for re-summarize. |

## Section 1 — Data model

Additive Prisma changes on the aligned schema. **`GamingSession`** gains the
mode/status fields; **`Transcription`** gains a nullable cluster link (no new
segment table); **`Member`**/**`Campaign`** gain relations.

```prisma
model Member {
  // ... existing campaign-sharing fields
  voiceSamples VoiceSample[]
}

model Campaign {
  // ... existing fields
  defaultTranscriptionMode TranscriptionMode @default(basic) @map("default_transcription_mode")
  diarizationEnabled       Boolean           @default(true)  @map("diarization_enabled")
  npcInferenceEnabled      Boolean           @default(true)  @map("npc_inference_enabled")

  speakerClusters SessionSpeakerCluster[] // for campaign-wide cascade queries
}

model GamingSession {
  // ... existing fields (status, transcriptionProgress, uploadId, …)
  transcriptionMode  TranscriptionMode @default(basic) @map("transcription_mode")
  diarizationStatus  DiarizationStatus @default(none)  @map("diarization_status")
  npcInferenceStatus InferenceStatus   @default(none)  @map("npc_inference_status")
  needsResummarize   Boolean           @default(false) @map("needs_resummarize")

  speakerClusters SessionSpeakerCluster[]
  diarizationJobs DiarizationJob[]
  npcSuggestions  NpcSuggestion[]
}

// EXTEND the existing aligned Transcription model — do not add a parallel table.
model Transcription {
  // existing: id Int, sessionId, startTime Float, endTime Float, text, confidence, createdAt
  speakerClusterId String? @map("speaker_cluster_id")   // null for basic-mode rows
  speakerCluster   SessionSpeakerCluster? @relation(fields: [speakerClusterId], references: [id], onDelete: SetNull)

  @@index([speakerClusterId])
}

enum TranscriptionMode { basic  speaker_labeled }
enum DiarizationStatus { none  queued  running  completed  failed }
enum InferenceStatus   { none  pending  completed  failed }

model VoiceSample {
  id                String   @id @default(cuid())
  memberId          String   @map("member_id")
  label             String                                    // "Thorin", "Narrator", "Skritch"
  audioPath         String   @map("audio_path")               // Blob path in voice-samples
  embedding         Bytes                                     // 192 * float32 = 768 bytes
  embeddingModel    String   @map("embedding_model")          // "ecapa-tdnn-v1"
  durationMs        Int      @map("duration_ms")
  source            VoiceSampleSource @default(enrolled)
  originalClusterId String?  @map("original_cluster_id")      // when source = tagged_from_cluster
  createdAt         DateTime @default(now()) @map("created_at")

  member   Member @relation(fields: [memberId], references: [id], onDelete: Cascade)
  clusters SessionSpeakerCluster[]

  @@unique([memberId, label])
  @@index([memberId])
}

enum VoiceSampleSource {
  enrolled            // recorded via the Voice Library UI
  tagged_from_cluster // promoted from a diarized cluster after the DM tagged it
}

model SessionSpeakerCluster {
  id                String   @id @default(cuid())
  sessionId         String   @map("session_id")
  campaignId        String   @map("campaign_id")              // denormalized for cascade scans
  clusterIdx        Int      @map("cluster_idx")              // 0..N-1 within session
  embeddingCentroid Bytes    @map("embedding_centroid")
  snippetBlobPath   String?  @map("snippet_blob_path")        // 10s representative clip
  snippetExpiresAt  DateTime? @map("snippet_expires_at")      // null = kept forever
  segmentCount      Int      @map("segment_count")
  totalDurationMs   Int      @map("total_duration_ms")
  voiceSampleId     String?  @map("voice_sample_id")          // matched OR after manual tag
  displayLabel      String   @map("display_label")            // "Thorin", "DM (narration)", "DM (Unknown #2)"
  createdAt         DateTime @default(now()) @map("created_at")

  session       GamingSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  campaign      Campaign      @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  voiceSample   VoiceSample?  @relation(fields: [voiceSampleId], references: [id], onDelete: SetNull)
  transcriptions Transcription[]
  npcSuggestion SessionNpcSuggestion?

  @@unique([sessionId, clusterIdx])
  @@index([voiceSampleId])
  @@index([campaignId])
}

model DiarizationJob {
  id              String           @id @default(cuid())
  sessionId       String           @map("session_id")
  status          DiarizationStatus
  aciResourceId   String?          @map("aci_resource_id")
  hmacSecret      String           @map("hmac_secret")        // hex, 32 bytes
  attemptCount    Int              @default(0) @map("attempt_count")
  region          String?
  bypassBudget    Boolean          @default(false) @map("bypass_budget")
  startedAt       DateTime?        @map("started_at")
  finishedAt      DateTime?        @map("finished_at")
  errorMessage    String?          @map("error_message")
  costEstimateUsd Decimal?         @map("cost_estimate_usd")
  createdAt       DateTime         @default(now()) @map("created_at")

  session GamingSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([status])
}

model SessionNpcSuggestion {
  id            String   @id @default(cuid())
  sessionId     String   @map("session_id")
  clusterId     String   @unique @map("cluster_id")
  suggestedName String   @map("suggested_name")
  confidence    String                                        // low | medium | high
  reasoning     String   @db.Text
  status        String   @default("pending")                  // pending | accepted | rejected
  createdAt     DateTime @default(now()) @map("created_at")
  resolvedAt    DateTime? @map("resolved_at")
  resolvedBy    String?  @map("resolved_by")                  // userId

  session GamingSession         @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  cluster SessionSpeakerCluster @relation(fields: [clusterId], references: [id], onDelete: Cascade)
}
```

Basic-mode sessions keep producing plain `Transcription` rows with
`speakerClusterId = null` (today's behaviour, unchanged). Speaker-labeled
sessions get `Transcription` rows whose `speakerClusterId` points at a cluster;
the labeled view is `Transcription JOIN SessionSpeakerCluster JOIN VoiceSample`.

## Section 2 — Voice enrollment

Every member of a campaign gets a personal **Voice Library** page. Each row is
a `VoiceSample`: label, duration, "Play", "Delete".

- **Players** add one or many samples — `Thorin`, `Thorin (drunk)`,
  `Thorin (bardic inspiration)`. Each labeled distinctly; no "primary" voice.
  Matching just picks the closest sample above threshold.
- **DM** must enroll at least one sample (their natural narrator voice) for
  diarization to be useful. They may pre-enroll recurring NPC voices
  (`Skritch the goblin`, `King Aldrin`), or skip and lazy-tag them after.

This is the "do both" decision: pre-enroll example voices for specific PCs/NPCs
and the DM **and** lazy-tag the leftovers as unknowns afterward.

**Recording UX:** browser `MediaRecorder`, target 15 s, 8 s min, 60 s max.
After stopping, the clip uploads to Blob (`voice-samples/{userId}/{sampleId}.opus`),
then is embedded **inline on the app's CPU** using the bundled ECAPA-TDNN ONNX
model (~0.5 s for a 15 s clip via `onnxruntime-node`). The 192-dim float32
vector is stored in `VoiceSample.embedding`.

**Uniqueness:** `(memberId, label)`. Renaming allowed.
**Deletion:** removes Blob + row; cascades to null `voiceSampleId` on past
`SessionSpeakerCluster`s, reverting their `displayLabel` to the "Unknown"
pattern. Past session audio is unaffected.

**Promoted (tagged-from-cluster) samples** appear in the DM's Voice Library
with an "auto-promoted" badge.

## Section 3 — Matching + lazy tagging

After the container returns clusters with mean embeddings, for each cluster:

1. Cosine similarity against every `VoiceSample.embedding` in the campaign.
2. `best ≥ MATCH_THRESHOLD` (start **0.65**; env-tunable — ECAPA same-speaker
   ≈ 0.6–0.8, different ≈ 0.2–0.4): set `voiceSampleId = best.id`,
   `displayLabel = best.label`.
3. No match: `voiceSampleId = null`, `displayLabel = "DM (Unknown #N)"` (per-
   session counter). Generate a 10 s snippet from the cluster's highest-VAD
   segment, upload to Blob, set `snippetExpiresAt = now + 30d`.

**Lazy-tagging cascade** — when the DM tags an unknown cluster with a name:

1. Create a `VoiceSample` under the DM's `Member`: label = name,
   `source = tagged_from_cluster`, `audioPath = cluster.snippetBlobPath`
   (promoted: clear `snippetExpiresAt`), `embedding = cluster.embeddingCentroid`,
   `originalClusterId = cluster.id`.
2. Link the cluster: `voiceSampleId = newSample.id`, `displayLabel = name`.
3. Scan every other `SessionSpeakerCluster` in the campaign
   (`campaignId = … AND voiceSampleId IS NULL`); cosine-compare to the new
   sample. Above threshold → auto-link + update `displayLabel`; mark each
   affected `GamingSession.needsResummarize = true`.
4. Affected sessions show a "Re-summarize" banner on next view.

Tag once → all past appearances across the campaign resolve.

## Section 4 — Diarization pipeline

**Trigger:** after transcription completes for a session where
`transcriptionMode = speaker_labeled` AND the campaign has ≥1 enrolled
`VoiceSample`, insert `DiarizationJob{status: queued}`. (Hooked into the
`/api/sessions/[id]/process` orchestrator after the transcription step, before
summary.)

**Dispatcher** (in-app, `setInterval` every 30 s on boot):

1. Pull oldest `queued` job within concurrency caps (max 1/campaign, max
   3 system-wide; both env).
2. Daily spend check (sum `costEstimateUsd` of jobs completed today). Over cap →
   keep queued, show "Daily diarization budget hit" banner with a per-session
   "Override" button. Override sets `bypassBudget = true`; dispatcher
   reconsiders. **Fail closed** otherwise.
3. Generate per-job HMAC secret (32 bytes hex) + a read-only Blob SAS URL for
   the session audio (the linked `Upload` blob, valid 2 h).
4. Iterate `DIARIZATION_REGIONS` (`centralus,westus2,eastus2`) and POST the ACI
   ARM create with image `DIARIZATION_IMAGE`, GPU=T4, env
   `{ AUDIO_URL, CALLBACK_URL, HMAC_SECRET, JOB_ID }`. First region to accept
   wins. Store `aciResourceId`, `region`, `status=running`, `startedAt`.

**Container** (`docker/diarization/`, image
`ghcr.io/domo929/dnd-recorder-diarization:latest`):
1. `curl` audio from the SAS URL.
2. Run pyannote 3.1 diarization **and** whisper word-level transcription;
   produce speaker-attributed segments `{ startMs, endMs, text, clusterIdx }`.
3. Per cluster, compute the mean ECAPA-TDNN embedding (same ONNX model).
4. POST result JSON to the callback with
   `X-Signature: hmac-sha256(secret, body)`.
5. Exit; the container group auto-terminates.

**Callback** (`POST /api/diarization/callback/[jobId]`):
1. Look up job, verify HMAC.
2. Upsert `SessionSpeakerCluster` rows from the payload.
3. Run §3 matching per cluster.
4. Upsert `Transcription` rows from the container's segments
   (`db.saveTranscriptions(...)` extended to set `speakerClusterId`), replacing
   the basic-mode rows for that session.
5. Generate unknown-cluster snippets (10 s, upload to
   `voice-samples/clusters/{sessionId}/{clusterIdx}.opus`).
6. `diarizationStatus = completed`, `attemptCount += 1`.
7. Trigger speaker-aware summary regeneration (§5).
8. Cluster centroids matching a `tagged_from_cluster` sample from a prior
   session pull labels forward automatically (same §3 code path).

**Cleanup loop** (every 60 s): find `running` jobs whose ACI is `Terminated`.
Callback received → delete the ACI resource group. No callback within 5 min of
termination → `status = failed`, `attemptCount += 1`, delete ACI. After 3
failures → permanent `failed`; session view shows "Retry diarization".

**Cost & guardrails:** T4 ACI ≈ $1.20/hr; a 1 h session diarizes in ~3–5 min
wall clock incl. cold start → $0.10–0.30/session. Envs:
`DIARIZATION_MAX_DAILY_USD` (5), `DIARIZATION_MAX_CONCURRENT` (3),
`DIARIZATION_MAX_PER_CAMPAIGN` (1).

## Section 5 — Speaker-aware transcript & summary

**Transcript view** (replaces the plain segment list on the session detail page
when `transcriptionMode = speaker_labeled` AND `diarizationStatus = completed`):

```
[00:12] Thorin                  "I kick the door down."
[00:14] DM (narration)          "The door splinters into..."
[00:18] DM (Skritch the goblin) "Oi! Who goes there!"
[00:22] DM (Unknown #2)         ▶ play snippet   [ Tag voice ▾ ]
[00:25] Elara                   "Stand down, goblin."
```

Implementation: `Transcription` rows (ordered by `startTime`) joined to
`SessionSpeakerCluster` joined to `VoiceSample`. Group consecutive rows from the
same cluster into one rendered "turn" with one label header. Unknown clusters
render a "Tag voice" affordance: dropdown of campaign `VoiceSample`s ("Maybe one
of these?") + "Create new…" — submission flows through the §3 cascade.

**Summary prompt** receives a speaker roster, then is passed to the existing
`generateAiText(prompt, 'summary')` — no new summary service:

```
You are summarizing a D&D session.

Speakers in this session:
- Thorin (PC, played by alice@example.com)
- Elara (PC, played by bob@example.com)
- DM (narration)
- DM (Skritch the goblin) — recurring NPC
- DM (Unknown #2) — unidentified NPC voice

Transcript:
[00:12] Thorin: "I kick the door..."
...

Produce a summary structured as:
1. What happened (chronological)
2. Key NPCs encountered (names where known, "an unidentified NPC voice" otherwise)
3. PC actions & decisions
4. Loose threads / open questions
```

**NPC inference pass** (once after summary, only if ≥1 unknown cluster, and
`Campaign.npcInferenceEnabled`): sends transcript + cluster IDs to
`generateAiText` asking for inferred names + confidence + reasoning per unknown
cluster; inserts `SessionNpcSuggestion{status: pending}`. UI panel:

```
🎭 Suggested NPC names
  DM (Unknown #2) → "Captain Voss"
    Reasoning: Thorin addresses this speaker as "Captain" at 14:32; the speaker
    self-identifies as Voss at 14:55.
    [ Accept ]  [ Reject ]  [ Edit name… ]
```

`Accept`/`Edit` → §3 cascade. `Reject` → `status = rejected`. Cost ≈ $0.001 via
the configured provider's cheapest model.

## Section 6 — Per-session mode + cost-aware re-summarize

**Per-upload toggle** on the session-create form:

```
○ Basic transcription
    Fast, free-form text. ~1 min/hour of audio. Cost: ~$0.00–0.06 per session.

● Speaker-labeled transcription
    Who said what. ~5 min wall-clock. Cost: ~$0.10–0.30 per session.
    Requires at least one enrolled voice (you have 4).
```

Pre-filled from `Campaign.defaultTranscriptionMode`. The speaker-labeled radio
is **disabled** when the campaign has zero `VoiceSample`s, tooltip "Enroll at
least one voice in the campaign to enable speaker-labeled transcription."

**AI-layer capability note:** basic mode uses the existing
`transcribeAudio(Buffer)` in `src/lib/ai.ts` unchanged. Speaker-labeled mode
gets its word-timestamped, speaker-attributed segments from the **GPU
container**, not from the app's transcription provider — so it works regardless
of which provider (`openai`/`google`/`whisper-local`) is configured for basic
transcription. No `transcribeWithTimestamps` extension to `ai.ts` is required.

**Re-summarize confirm dialog**, model-aware (keys match `src/lib/ai.ts`
provider:model naming and the Phase B defaults `gpt-4o` / `gemini-2.5-flash`):

```ts
const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'openai:gpt-4o':           { inputPer1M: 2.50,  outputPer1M: 10.00 },
  'openai:gpt-4o-mini':      { inputPer1M: 0.15,  outputPer1M: 0.60 },
  'google:gemini-2.5-flash': { inputPer1M: 0.075, outputPer1M: 0.30 },
  'google:gemini-1.5-pro':   { inputPer1M: 1.25,  outputPer1M: 5.00 },
};
```

`estimateSummaryCost(provider, modelId, transcriptChars)` returns USD or null.
Dialog:

```
Re-summarize this session?
Using Google Gemini 2.5 Flash (~12K input tokens, ~1K output tokens).
Estimated cost: $0.0012
[ Cancel ]  [ Re-summarize ]
```

Unknown model → "Estimated cost unavailable", button still enabled. Same dialog
whether manual or auto-prompted by the §3 cascade (`needsResummarize = true`).

## Operational concerns

**New infrastructure** (`Domo929/dnd-recorder-deploy`):
- Reuses the Blob storage account from the blob-uploads design; the
  `voice-samples` container is created empty there.
- GHCR image `ghcr.io/domo929/dnd-recorder-diarization:latest`.
- Azure RBAC for the App Service managed identity to call ACI ARM endpoints and
  generate Blob SAS URLs.

**Env vars added to the app:**
```
AZURE_BLOB_VOICE_CONTAINER=voice-samples   # also referenced by blob-uploads
AZURE_BLOB_SAS_TTL_HOURS=2
DIARIZATION_REGIONS=centralus,westus2,eastus2
DIARIZATION_MAX_DAILY_USD=5
DIARIZATION_MAX_CONCURRENT=3
DIARIZATION_MAX_PER_CAMPAIGN=1
DIARIZATION_IMAGE=ghcr.io/domo929/dnd-recorder-diarization:latest
DIARIZATION_CALLBACK_BASE_URL=https://<app-hostname>
MATCH_THRESHOLD_COSINE=0.65
AUDIO_RETENTION_DAYS=14
UNKNOWN_SNIPPET_RETENTION_DAYS=30
```

**Cron jobs** (in-app `setInterval`):
- Diarization dispatcher: every 30 s.
- ACI cleanup: every 60 s.
- Audio retention purge: daily 03:00 UTC. Deletes Blob audio + nulls the
  `Upload` blob for uploads whose `Upload.audioExpiresAt < now`. Keeps
  transcripts, clusters, summaries. (When `speaker_labeled` mode is chosen, the
  link/complete step sets `Upload.audioExpiresAt = now + AUDIO_RETENTION_DAYS`.)
- Unknown-snippet purge: daily 03:15 UTC. Deletes snippets whose
  `snippetExpiresAt < now`; leaves the cluster row (DM still sees "Unknown #N"
  without a playable snippet, can delete the cluster manually).

## What's deferred (V2+)

- Multi-mic / per-channel recording (bypasses diarization entirely).
- **Guest speakers** — non-member voices in a campaign. For now they fall under
  "Unknown" with manual tagging. (Explicitly deferred per the design
  discussion.)
- Auto-learn from corrections (re-label cluster X as Thorin 3 sessions running →
  suggest updating Thorin's enrolled sample).
- Audio retention beyond 14 days (paid-tier feature).
- Cluster-merge UI for pyannote over-splitting one speaker.

## Open questions

None blocking. Future investigation: tuning `MATCH_THRESHOLD_COSINE` against
real campaign data once we have labeled sessions to evaluate against.
