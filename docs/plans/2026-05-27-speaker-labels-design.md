> ⚠️ **NEEDS REWRITE (post upstream-alignment).** This design was written
> against the pre-alignment fork architecture (our `Member` schema, our
> `src/services/ai/*` layout). After re-founding on `upstream/staging`, the
> data model must be re-derived against upstream's `GamingSession.userId` plus
> the campaign-sharing `Member` tables. See
> `files/upstream-alignment-master-plan.md` Phase D. Treat the content below as
> intent, not a literal spec.

# Speaker labels — design

**Date:** 2026-05-27
**Status:** Approved, ready for implementation
**Author:** brainstormed with Copilot CLI

## Goal

Turn the current "wall-of-text" transcripts into speaker-labeled transcripts that
identify **who** said **what** for every utterance in a session — players by
their character names, the DM by their narrator voice, and recurring NPCs by
the voices the DM gives them.

Input is a **single-microphone mixed recording** (everyone in the room sharing
one mic), which is the hardest acoustic case and is what dictates most of the
architecture below (real diarization required, not channel separation).

The same feature must be opt-in **per upload** so a DM can run cheap basic
transcription for filler sessions and the full speaker-labeled pipeline only
for sessions where it matters.

## Decisions

| Question | Decision |
| --- | --- |
| Compute path for diarization | On-demand Azure Container Instance with a T4 GPU per session. App stays on the B2 plan. |
| Diarization model | `pyannote.audio` 3.1 speaker-diarization pipeline. |
| Voice embedding model | SpeechBrain ECAPA-TDNN, ONNX-exported, bundled in app image. 192-dim float32. Same model used both inline (enrollment) and inside the GPU container (per-cluster centroid). |
| Audio storage | Azure Blob Storage. Session audio in `sessions/{sessionId}/{filename}`, enrollment & promoted-NPC clips in `voice-enrollments/{userId}/{sampleId}.opus`. |
| Session audio retention | 14 days, daily cron purge. After purge, re-processing a session is no longer possible. |
| Enrollment / NPC clip retention | Forever, deletable by the owner via "delete this voice" button. |
| Unknown-cluster snippet retention | 30 days (long enough to give the DM time to tag); promoted to permanent if/when the DM tags it. |
| Per-upload mode | `basic` (current behaviour) vs `speaker_labeled`. Per-campaign default in campaign settings, overridable per upload. |
| Voice samples per member | Unlimited. Each labeled (`Thorin`, `Thorin (drunk)`, `Skritch the goblin`, `Narrator`). Each voice is its own row; no "primary" flag. |
| Transcript display for variant voices | Show each sample's full label distinctly (`Thorin` vs `Thorin (drunk)`), don't collapse. |
| DM fallback rule | Clusters that match no enrolled voice are labeled `DM (Unknown #N)` and surfaced with a playable audio snippet for lazy tagging. |
| NPC inference | LLM post-pass produces suggestions; DM must accept/reject before they apply. Never auto-apply. |
| Re-summarize cost transparency | Confirm dialog shows estimated cost based on the **currently configured** summary provider/model (gemini, gpt-4o, etc.). |
| Spend guardrail | Daily GPU spend cap (env-configurable, default $5/day). Fail closed when hit, with per-session "override and run anyway" button. |
| ACI region preference | `centralus,westus2,eastus2` — try in order until one accepts the create. T4 currently isn't published in Central US, but we keep it first in the list for the day MS adds it. |
| Failure handling | ACI failures retried 3× with backoff. After 3 failures, surface a "Retry diarization" button on the session view. |
| Callback security | Per-job 32-byte HMAC secret signs the result POST so a leaked URL from one session can't replay against another. |
| Tag cascade | Tagging an unknown cluster creates a `voice_sample`, then searches every other unknown cluster across all sessions in the campaign for a similarity match, and flags affected sessions for re-summarize. |

## Section 1 — Data model

```prisma
model Member {
  // ... existing fields
  voiceSamples VoiceSample[]
}

model Campaign {
  // ... existing fields
  defaultTranscriptionMode TranscriptionMode @default(basic) @map("default_transcription_mode")
  diarizationEnabled       Boolean           @default(true)  @map("diarization_enabled")
  npcInferenceEnabled      Boolean           @default(true)  @map("npc_inference_enabled")

  voiceSamples       VoiceSample[]        // accessed via members; relation kept for cascade
  speakerClusters    SessionSpeakerCluster[]
}

model Session {
  // ... existing fields
  transcriptionMode    TranscriptionMode  @default(basic)  @map("transcription_mode")
  diarizationStatus    DiarizationStatus  @default(none)   @map("diarization_status")
  npcInferenceStatus   InferenceStatus    @default(none)   @map("npc_inference_status")
  needsResummarize     Boolean            @default(false)  @map("needs_resummarize")
  audioBlobPath        String?            @map("audio_blob_path")
  audioExpiresAt       DateTime?          @map("audio_expires_at")

  transcriptSegments   TranscriptSegment[]
  speakerClusters      SessionSpeakerCluster[]
  diarizationJobs      DiarizationJob[]
  npcSuggestions       NpcSuggestion[]
}

enum TranscriptionMode {
  basic
  speaker_labeled
}

enum DiarizationStatus {
  none
  queued
  running
  completed
  failed
}

enum InferenceStatus {
  none
  pending
  completed
  failed
}

model VoiceSample {
  id                String   @id @default(cuid())
  memberId          String   @map("member_id")
  label             String                                       // "Thorin", "Narrator", "Skritch"
  audioPath         String   @map("audio_path")                  // Blob path
  embedding         Bytes                                        // 192 * float32 = 768 bytes
  embeddingModel    String   @map("embedding_model")             // "ecapa-tdnn-v1"
  durationMs        Int      @map("duration_ms")
  source            VoiceSampleSource @default(enrolled)
  originalClusterId String?  @map("original_cluster_id")         // when source=tagged_from_cluster
  createdAt         DateTime @default(now()) @map("created_at")

  member            Member   @relation(fields: [memberId], references: [id], onDelete: Cascade)
  clusters          SessionSpeakerCluster[]

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
  clusterIdx        Int      @map("cluster_idx")               // 0..N-1 within session
  embeddingCentroid Bytes    @map("embedding_centroid")
  snippetBlobPath   String?  @map("snippet_blob_path")         // 10s representative clip
  snippetExpiresAt  DateTime? @map("snippet_expires_at")       // null = kept forever
  segmentCount      Int      @map("segment_count")
  totalDurationMs   Int      @map("total_duration_ms")
  voiceSampleId     String?  @map("voice_sample_id")           // matched OR after manual tag
  displayLabel      String   @map("display_label")             // "Thorin", "DM (narration)", "DM (Unknown #2)"
  createdAt         DateTime @default(now()) @map("created_at")

  session           Session         @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  voiceSample       VoiceSample?    @relation(fields: [voiceSampleId], references: [id], onDelete: SetNull)
  segments          TranscriptSegment[]
  npcSuggestion     NpcSuggestion?

  @@unique([sessionId, clusterIdx])
  @@index([voiceSampleId])
}

model TranscriptSegment {
  id           String  @id @default(cuid())
  sessionId    String  @map("session_id")
  ord          Int                                  // 0..N-1, render order
  startMs      Int     @map("start_ms")
  endMs        Int     @map("end_ms")
  text         String
  clusterId    String? @map("cluster_id")           // null for basic-mode transcripts

  session      Session                 @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  cluster      SessionSpeakerCluster?  @relation(fields: [clusterId], references: [id], onDelete: SetNull)

  @@unique([sessionId, ord])
  @@index([sessionId])
}

model DiarizationJob {
  id            String           @id @default(cuid())
  sessionId     String           @map("session_id")
  status        DiarizationStatus
  aciResourceId String?          @map("aci_resource_id")
  hmacSecret    String           @map("hmac_secret")        // hex, 32 bytes
  attemptCount  Int              @default(0) @map("attempt_count")
  region        String?
  startedAt     DateTime?        @map("started_at")
  finishedAt    DateTime?        @map("finished_at")
  errorMessage  String?          @map("error_message")
  costEstimateUsd Decimal?       @map("cost_estimate_usd")
  createdAt     DateTime         @default(now()) @map("created_at")

  session       Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([status])
}

model NpcSuggestion {
  id              String   @id @default(cuid())
  sessionId       String   @map("session_id")
  clusterId       String   @unique @map("cluster_id")
  suggestedName   String   @map("suggested_name")
  confidence      String                                       // low | medium | high
  reasoning       String   @db.Text
  status          String   @default("pending")                 // pending | accepted | rejected
  createdAt       DateTime @default(now()) @map("created_at")
  resolvedAt      DateTime? @map("resolved_at")
  resolvedBy      String?  @map("resolved_by")                 // userId

  session         Session                 @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  cluster         SessionSpeakerCluster   @relation(fields: [clusterId], references: [id], onDelete: Cascade)
}
```

Existing `Session.transcript` (single text blob) stays as the source of truth
for basic-mode sessions and as a fallback view for speaker-labeled sessions.
Speaker-labeled view is rendered from `TranscriptSegment` joined to
`SessionSpeakerCluster`.

## Section 2 — Voice enrollment

Every member of a campaign gets a personal **Voice Library** page. Each row is
a `VoiceSample`: label, duration, "Play", "Delete".

- **Players** may add one or many samples — `Thorin`, `Thorin (drunk)`,
  `Thorin (bardic inspiration)`, etc. Each labeled distinctly. There is no
  "primary" voice; matching just picks whichever sample is closest in cosine
  similarity above threshold.
- **DM** must enroll at least one sample (their natural narrator voice) for
  diarization to be useful. They may pre-enroll recurring NPC voices as
  separate samples (`Skritch the goblin`, `King Aldrin`), or skip and let
  those get lazy-tagged after sessions.

**Recording UX:** browser MediaRecorder, target 15 s, 8 s minimum, 60 s
maximum. After stopping, the clip is uploaded to Blob (`voice-enrollments/{userId}/{sampleId}.opus`),
then embedded **inline on the app's CPU** using the bundled ECAPA-TDNN ONNX
model (~0.5 s for a 15 s clip via `onnxruntime-node`). The resulting 192-dim
float32 vector is stored in `VoiceSample.embedding`.

**Sample uniqueness:** `(memberId, label)` unique. Renaming allowed.
**Deletion:** removes Blob + row; cascades to nullify `voiceSampleId` on past
`SessionSpeakerCluster`s, which causes their `displayLabel` to revert to the
"Unknown" pattern. The original audio of past sessions is unaffected.

**Promoted (tagged-from-cluster) samples** appear in the same Voice Library
under the DM's account, marked with a small "auto-promoted" badge so the DM
can tell the difference from their own enrolled samples.

## Section 3 — Matching + lazy tagging

After diarization (§4) produces clusters with mean embeddings, for each
cluster:

1. Compute cosine similarity against every `VoiceSample.embedding` in the
   campaign.
2. If `best ≥ MATCH_THRESHOLD` (start at **0.65** — ECAPA same-speaker is
   typically 0.6–0.8, different-speaker 0.2–0.4; threshold lives in env so we
   can tune): assign `voiceSampleId = best.id`, `displayLabel = best.label`.
3. If no match: `voiceSampleId = null`, `displayLabel = "DM (Unknown #N)"`
   where N is a per-session counter. Generate a representative 10 s snippet
   from the cluster's highest-VAD-energy segment, upload to Blob, set
   `snippetExpiresAt = now + 30d`.

**Lazy tagging cascade:**

When the DM tags an unknown cluster (via the §6 UI panel) with a name
(`"Skritch the goblin"`), the system:

1. Creates a `VoiceSample` under the DM's `Member`, label = the supplied name,
   `source = tagged_from_cluster`, `audioPath = cluster.snippetBlobPath`
   (promoted: `snippetExpiresAt` cleared), `embedding = cluster.embeddingCentroid`,
   `originalClusterId = cluster.id`.
2. Links the cluster: `voiceSampleId = newSample.id`, `displayLabel = newSample.label`.
3. Scans every other `SessionSpeakerCluster` in the campaign where
   `voiceSampleId IS NULL`; for each, computes cosine similarity to the new
   sample. Above `MATCH_THRESHOLD`: auto-link and update `displayLabel`. Mark
   each affected session `needsResummarize = true`.
4. Any session whose labels changed shows a "Re-summarize" banner on next view.

Net effect: tag once, all past appearances of that voice across the whole
campaign resolve, and a re-summarize prompt surfaces on each affected session.

## Section 4 — Diarization pipeline

**Trigger:** After transcription completes for a session where
`transcriptionMode = speaker_labeled` AND the campaign has ≥1 enrolled
`VoiceSample`, insert `DiarizationJob{status: queued}`.

**Dispatcher** (in-app, runs every 30 s via a simple `setInterval` loop on
boot):

1. Pull oldest `queued` job, respecting concurrency caps (max 1 per campaign,
   max 3 system-wide; both env-configurable).
2. Check daily spend cap (sum of `costEstimateUsd` for jobs `completed` today).
   If exceeded: keep job queued, surface "Daily diarization budget hit" banner
   in UI with a per-session "Override" button. Override sets a
   `bypassBudget=true` flag on the job and the dispatcher re-considers it.
3. Generate per-job HMAC secret (32 random bytes hex), generate signed Blob
   SAS URL for the audio (valid 2 h, read-only).
4. Iterate `DIARIZATION_REGIONS` env list (`centralus,westus2,eastus2` by
   default) and POST to the Azure ACI ARM endpoint to create a container group
   with: image `ghcr.io/domo929/dnd-recorder-diarization:latest`, GPU=T4,
   env=`{ AUDIO_URL, CALLBACK_URL, HMAC_SECRET, JOB_ID }`. First region that
   accepts the create wins. Store `aciResourceId`, `region`,
   `status=running`, `startedAt=now`.

**Container** (separate Dockerfile in `docker/diarization/`):
1. `curl` audio from SAS URL to local disk.
2. Run pyannote.audio 3.1 pipeline (loads model from baked-in HF cache).
3. For each cluster, compute mean ECAPA-TDNN embedding over its segments
   using the same ONNX model bundled in the app.
4. POST result JSON to callback URL with `X-Signature: hmac-sha256(secret, body)`
   header.
5. Exit. Container group auto-terminates.

**Callback handler** (`/api/diarization/callback/[jobId]`):
1. Lookup job, verify HMAC against stored secret.
2. Upsert `SessionSpeakerCluster` rows from payload.
3. Run §3 matching for each new cluster.
4. Align Whisper word timestamps to cluster segments → upsert
   `TranscriptSegment` rows.
5. Generate representative snippets for unknown clusters (extract from the
   audio still cached in Blob, 10 s clip, upload to
   `clusters/{sessionId}/{clusterIdx}.opus`).
6. Update `session.diarizationStatus = completed`, `attemptCount` += 1.
7. Trigger speaker-aware summary regeneration (§5).
8. If any cluster centroid matches an existing `VoiceSample` that itself came
   from `tagged_from_cluster` in a previous session, that's the lazy-cascade
   pulling labels forward automatically — same code path as §3.

**Dispatcher cleanup loop:** every 60 s, find jobs `running` whose ACI status
is `Terminated`. If callback already received → delete the ACI resource group.
If callback NOT received within 5 min of termination → mark job failed,
`attemptCount += 1`, delete ACI. After 3 failures: status=failed permanently;
session view shows "Retry diarization" button.

**Cost & guardrails:**
- T4 GPU ACI ≈ $1.20/hr; typical 1 h session diarizes in ~3-5 min wall clock
  including cold start. Per-session estimate $0.10–0.30.
- `DIARIZATION_MAX_DAILY_USD` env var, default $5.
- `DIARIZATION_MAX_CONCURRENT` env var, default 3.
- `DIARIZATION_MAX_PER_CAMPAIGN` env var, default 1.

## Section 5 — Speaker-aware transcript & summary

**Transcript view** (replaces single `<pre>` block on the session detail page
when `transcriptionMode = speaker_labeled` and `diarizationStatus = completed`):

```
[00:12] Thorin                  "I kick the door down."
[00:14] DM (narration)          "The door splinters into..."
[00:18] DM (Skritch the goblin) "Oi! Who goes there!"
[00:22] DM (Unknown #2)         ▶ play snippet   [ Tag voice ▾ ]
[00:25] Elara                   "Stand down, goblin."
```

Implementation: `TranscriptSegment` rows joined to `SessionSpeakerCluster`
joined to `VoiceSample`. Group consecutive segments from the same cluster
into a single rendered "turn" with one label header.

Unknown clusters render with a "Tag voice" affordance: dropdown of existing
campaign `VoiceSample`s ("Maybe one of these?") plus a "Create new…" text
input. Submission flows through the §3 cascade.

**Word-level alignment:** Whisper word timestamps map to clusters by `startMs`
overlap. Words straddling a boundary go to the cluster owning the larger
overlap.

**Summary prompt template** receives a speaker roster as a system prompt:

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

Produce a session summary structured as:
1. What happened (chronological)
2. Key NPCs encountered (use names where known, "an unidentified NPC voice" otherwise)
3. PC actions & decisions
4. Loose threads / open questions
```

The provider abstraction (`SummaryService` returning a Vercel AI SDK
`LanguageModel`) is unchanged — the speaker-aware prompt is just a different
prompt the route layer assembles.

**NPC inference pass** (runs once after summary generation, only for sessions
with ≥1 unknown cluster):

Sends transcript + cluster identifiers to the configured summary provider with
a prompt asking for inferred names per unknown cluster + confidence + reasoning.
Inserts `NpcSuggestion{status: pending}` rows. UI surfaces a panel:

```
🎭 Suggested NPC names
  DM (Unknown #2) → "Captain Voss"
    Reasoning: Thorin addresses this speaker as "Captain" at 14:32, and
    the speaker self-identifies as Voss at 14:55.
    [ Accept ]  [ Reject ]  [ Edit name… ]
```

`Accept` routes through the §3 cascade. `Reject` sets `status = rejected`.
`Edit` lets the DM type a different name, then cascade.

Cost: ~$0.001 per session via the configured provider's cheapest model. Toggle
off per-campaign with `Campaign.npcInferenceEnabled`.

## Section 6 — Per-session mode + cost-aware re-summarize

**Per-upload toggle** on the session-create form:

```
○ Basic transcription
    Fast, free-form text. ~1 min/hour of audio. Cost: ~$0.00–0.06 per session.

● Speaker-labeled transcription
    Who said what. ~5 min wall-clock. Cost: ~$0.10–0.30 per session.
    Requires at least one enrolled voice (you have 4).
```

Pre-filled from `Campaign.defaultTranscriptionMode`. The radio for
speaker-labeled is **disabled** when the campaign has zero `VoiceSample`s,
with tooltip "Enroll at least one voice in the campaign to enable
speaker-labeled transcription."

**Transcription provider abstraction extension:**

```ts
export interface TimestampedTranscript {
  words: Array<{ word: string; startMs: number; endMs: number }>;
  fullText: string;  // for compatibility with the existing summary path
}

export interface TranscriptionService {
  readonly name: TranscriptionProvider;
  transcribe(audioPath: string): Promise<string>;
  transcribeWithTimestamps?(audioPath: string): Promise<TimestampedTranscript>;
}
```

Providers without `transcribeWithTimestamps` cause speaker-labeled mode to be
disabled with a different tooltip ("Current transcription provider doesn't
support word timestamps. Switch to OpenAI or Google in settings.").

**Re-summarize confirm dialog**, model-aware:

```ts
const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'openai:gpt-4o':                 { inputPer1M: 2.50, outputPer1M: 10.00 },
  'openai:gpt-4o-mini':            { inputPer1M: 0.15, outputPer1M: 0.60 },
  'google:gemini-2.0-flash-exp':   { inputPer1M: 0.075, outputPer1M: 0.30 },
  'google:gemini-1.5-pro':         { inputPer1M: 1.25, outputPer1M: 5.00 },
};
```

`estimateSummaryCost(provider, modelId, transcriptChars)` returns USD or null
(unknown model). Dialog:

```
Re-summarize this session?
Using Google Gemini 2.0 Flash (~12K input tokens, ~1K output tokens).
Estimated cost: $0.0012
[ Cancel ]  [ Re-summarize ]
```

Unknown model → "Estimated cost unavailable" message, button still enabled.
Same dialog whether triggered manually or auto-prompted by the §3 cascade
(`needsResummarize = true`).

## Operational concerns

**New infrastructure** (lives in `Domo929/dnd-recorder-deploy`):

- Azure Blob Storage account, two containers: `audio-sessions`, `voice-samples`.
- GitHub Container Registry image: `ghcr.io/domo929/dnd-recorder-diarization:latest`.
- Azure RBAC for App Service managed identity to call ACI ARM endpoints and
  generate Blob SAS URLs.

**Env vars added to the app:**

```
AZURE_BLOB_ACCOUNT_NAME
AZURE_BLOB_AUDIO_CONTAINER=audio-sessions
AZURE_BLOB_VOICE_CONTAINER=voice-samples
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

**Cron jobs** (run inside the app process via simple `setInterval`):
- Diarization dispatcher: every 30 s.
- ACI cleanup: every 60 s.
- Audio retention purge: daily at 03:00 UTC. Deletes Blob audio + clears
  `Session.audioBlobPath` for sessions whose `audioExpiresAt < now`. Does NOT
  delete transcripts, segments, clusters, or summaries.
- Unknown-snippet purge: daily at 03:15 UTC. Deletes snippets whose
  `snippetExpiresAt < now`; leaves the cluster row (DM can still see "Unknown
  #N" with no snippet to play, and can manually delete the cluster from the UI
  if they want).

## What's deferred (V2+)

- Multi-mic / per-channel recording (everyone on a separate USB mic). Would
  bypass diarization entirely and just align channels.
- Guest speakers — non-member voices appearing in a campaign. For now they
  fall under "Unknown" with manual tagging.
- Auto-learn from corrections: if the DM consistently re-labels cluster X as
  Thorin in 3 sessions in a row, suggest replacing Thorin's enrolled sample
  with X's embedding.
- Audio retention longer than 14 days (paid tier feature).
- Cluster-merge UI for cases where pyannote over-splits a single speaker.

## Open questions

None blocking. Future investigation:
- Real-world MATCH_THRESHOLD tuning against actual recordings — 0.65 is a
  starting point.
- Whether to transcode session audio from WAV to OPUS @ 32 kbps after
  transcription to shrink Blob storage (1 GB → ~45 MB per session). Minor cost
  optimization; can wait.
- Whether ACI cold-start can be reduced by keeping a warm container pool
  during typical session times (probably not worth the standing cost for a
  hobbyist workload).
