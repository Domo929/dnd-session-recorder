# Self-refining voice fingerprints — design

**Date:** 2026-05-29
**Status:** Approved, ready for implementation
**Author:** brainstormed with Copilot CLI
**Extends:** `docs/plans/2026-05-27-speaker-labels-design.md` (the speaker-labels
epic). This is an additive refinement to that design; nothing here replaces it.

## Goal

Today a voice is a single, frozen embedding captured once (at enrollment, or
when promoted from a tagged cluster). Matching is a one-shot cosine comparison
against that static vector. This document turns each voice into a **living
fingerprint** that *learns* from real sessions: every time we confidently
recognise a voice, we fold that session's audio back into the fingerprint, so
recognition gets more accurate and more robust to natural voice variation over
time — without ever drifting away from the voice the user deliberately
enrolled.

## Decisions

| Question | Decision |
| --- | --- |
| Fingerprint granularity | **Hybrid.** Per labeled voice (each `VoiceSample` is its own fingerprint, variants stay distinct) **plus** a person-level fallback that aggregates all of a `Member`'s voices. |
| Fingerprint representation | **Capped set of exemplar embeddings** (not a single running mean). Match against all exemplars. More robust to voice variation than one averaged vector. |
| Per-voice cap / eviction | **10 exemplars** per voice. The original hand-enrolled exemplar is **pinned** (never evicted). When full, evict the **oldest unpinned** exemplar. |
| Scoring | **Max** cosine similarity over a voice's exemplars. Person fallback = max over **all** that member's voices' exemplars. |
| When to learn | Add an exemplar **only** on (a) a DM-confirmed match, or (b) an auto-match scoring ≥ `LEARN_THRESHOLD` (stricter than the match threshold). Low-confidence / fallback matches never learn. Anti-poisoning. |
| Person-fallback labeling | If no single voice clears the match threshold but the person does, attribute to that member's **closest voice**, flag the cluster **low-confidence** for DM review, and do **not** auto-learn from it. |

## Section 1 — Data model

Additive Prisma changes, folded into the still-unmerged SL-1 schema branch
(PR #14). A voice's fingerprint becomes a one-to-many set of exemplars; the
existing `VoiceSample.embedding` column is retained as the canonical, pinned
seed exemplar for backward compatibility.

```prisma
model VoiceSample {
  // ... existing fields (id, memberId, label, audioPath, embedding,
  //     embeddingModel, durationMs, source, originalClusterId, createdAt)
  exemplarCount Int             @default(1) @map("exemplar_count")
  exemplars     VoiceExemplar[]
}

model VoiceExemplar {
  id                  String   @id @default(cuid())
  voiceSampleId       String   @map("voice_sample_id")
  embedding           Bytes                                       // 192 * float32 = 768 bytes
  embeddingModel      String   @map("embedding_model")            // "ecapa-tdnn-v1"
  source              VoiceExemplarSource @default(enrolled)
  pinned              Boolean  @default(false)                    // true only for the original enrollment seed
  sourceSessionId     String?  @map("source_session_id")          // session this exemplar was learned from
  similarityAtCapture Float?   @map("similarity_at_capture")      // score at the moment of learning
  durationMs          Int      @map("duration_ms")
  createdAt           DateTime @default(now()) @map("created_at")

  voiceSample VoiceSample @relation(fields: [voiceSampleId], references: [id], onDelete: Cascade)

  @@unique([voiceSampleId, sourceSessionId])   // idempotent: one exemplar per source session
  @@index([voiceSampleId])
}

enum VoiceExemplarSource {
  enrolled             // the original recorded enrollment (pinned)
  auto_matched         // learned from a high-confidence automatic match
  dm_confirmed         // learned after the DM explicitly confirmed/tagged
  tagged_from_cluster  // seeded from a lazy-tagged unknown cluster
}

model SessionSpeakerCluster {
  // ... existing speaker-labels fields
  matchConfidence String  @default("none") @map("match_confidence")  // high | low | none
  matchedScore    Float?  @map("matched_score")                      // best cosine score, for transparency
}
```

**Invariants:**
- Exactly one `pinned` exemplar per voice (the enrollment seed). It is never
  evicted and cannot be deleted via the UI.
- `exemplarCount` mirrors the number of `VoiceExemplar` rows and is capped at
  `MAX_EXEMPLARS_PER_VOICE` (10).
- `@@unique([voiceSampleId, sourceSessionId])` makes learning idempotent:
  re-processing a session updates the existing exemplar rather than duplicating
  it, so a fingerprint can never be inflated by re-runs.

## Section 2 — Matching & the person-level fallback

For each session cluster centroid `c` (from the diarization container):

1. **Per-voice score (primary).** For every `VoiceSample` in the campaign,
   `voiceScore = max(cosine(c, e)) for e in voice.exemplars`. Pick the campaign
   best `bestVoice`.
   - `bestVoiceScore ≥ MATCH_THRESHOLD` (0.65) → **confident match**:
     `voiceSampleId = bestVoice.id`, `displayLabel = bestVoice.label`,
     `matchConfidence = "high"`, `matchedScore = bestVoiceScore`.
2. **Person-level fallback (hybrid layer).** If no voice clears 0.65, group
   exemplars by `Member` and compute
   `personScore = max(cosine(c, e)) for e in all of member's voices' exemplars`.
   Pick the best member.
   - `bestPersonScore ≥ PERSON_FALLBACK_THRESHOLD` (0.55) → attribute to that
     member's **closest voice**: `voiceSampleId = closestVoiceOfPerson`,
     `displayLabel = "{label} (?)"`, `matchConfidence = "low"`,
     `matchedScore = bestPersonScore`. Surfaced for DM confirm/correct.
     **Never auto-learns** (see §3).
3. **No match.** Below 0.55 → existing Unknown-cluster path
   (`displayLabel = "DM (Unknown #N)"`, 30-day snippet, lazy-tag later).

Thresholds are env-tunable (`MATCH_THRESHOLD`, `PERSON_FALLBACK_THRESHOLD`).
Using `max` over exemplars (rather than mean) keeps a single strong exemplar
authoritative and is forgiving of within-voice variation.

## Section 3 — Learning (when & how a fingerprint refines)

After a cluster is resolved to a voice in the diarization callback, **add a new
exemplar only if** one of:

- the match is **DM-confirmed** (the DM explicitly accepted/tagged the cluster)
  → `source = dm_confirmed`; or
- it is an **auto-match** with `matchedScore ≥ LEARN_THRESHOLD` (≈ **0.80**,
  strictly above the 0.65 match threshold) → `source = auto_matched`.

Everything else attributes a label but **does not learn**: plain 0.65–0.80
auto-matches, all low-confidence person-fallback matches, and Unknown clusters.
This is the anti-poisoning rule — only high-confidence audio refines a voice.

**Add procedure:**
1. Insert `VoiceExemplar { voiceSampleId, embedding = cluster.embeddingCentroid,
   embeddingModel, source, pinned = false, sourceSessionId,
   similarityAtCapture = matchedScore, durationMs }`.
   The `@@unique([voiceSampleId, sourceSessionId])` makes this an upsert.
2. `exemplarCount = count(exemplars)`.
3. If `exemplarCount > MAX_EXEMPLARS_PER_VOICE`, delete the **oldest unpinned**
   exemplar (`ORDER BY createdAt ASC WHERE pinned = false LIMIT 1`).

**Interactions:**
- **Lazy-tag cascade (existing §3 of the base design):** tagging an unknown
  cluster still creates the seed `VoiceSample` (its first exemplar pinned,
  `source = tagged_from_cluster`). Subsequent confident appearances then accrete
  as unpinned exemplars normally.
- **Re-summarize / re-process:** idempotent by `sourceSessionId`, so safe.
- **Deletion:** deleting a `VoiceSample` cascade-deletes its exemplars.
  Individual unpinned exemplars are deletable from the Voice Library for manual
  cleanup; the pinned seed is locked.

## Section 4 — UX & observability

**Voice Library.** Each voice row shows a "learned from N sessions" indicator
and an expandable exemplar list: source badge (enrolled / auto / DM-confirmed /
promoted), capture date, and `similarityAtCapture`. The pinned enrollment shows
a lock icon; unpinned exemplars have a delete control. This makes the
fingerprint's evolution visible and fully reversible.

**Cluster review.** Low-confidence (`matchConfidence = "low"`) clusters render
with the `{label} (?)` style and a confirm/relabel control. Confirming flips
`matchConfidence → high` and **retroactively learns** (adds the cluster as a
`dm_confirmed` exemplar via the §3 procedure).

## Section 5 — Phasing

Rides the existing speaker-labels epic; no new top-level phase.

- **SL-1 (PR #14, open):** fold in the additive schema — `VoiceExemplar` model +
  `VoiceExemplarSource` enum, `VoiceSample.exemplarCount`,
  `SessionSpeakerCluster.matchConfidence` + `matchedScore`. Regenerate the
  migration (pre-merge, so amend rather than stack).
- **SL-2 (embedding/matching helpers):** implement max-over-exemplar scoring,
  the person-level fallback, and the learn-gate as pure functions with unit
  tests (mock embeddings; no model file needed in CI).
- **SL-3 (enrollment):** seed the pinned exemplar on enrollment; Voice Library
  exemplar UI.
- **SL-4 (diarization callback):** wire learning into cluster resolution.
- **SL-5 (transcript/summary/NPC + cluster review):** confirm-to-learn UI.

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `MATCH_THRESHOLD` | 0.65 | Per-voice confident-match cosine threshold (existing). |
| `PERSON_FALLBACK_THRESHOLD` | 0.55 | Person-level fallback threshold for low-confidence attribution. |
| `LEARN_THRESHOLD` | 0.80 | Minimum auto-match score to fold a cluster into a fingerprint. |
| `MAX_EXEMPLARS_PER_VOICE` | 10 | Per-voice exemplar cap; oldest unpinned evicted past this. |

## What's deferred (V2+)

- Diversity-aware eviction (drop the most redundant exemplar instead of the
  oldest). Start with oldest-unpinned for simplicity.
- EMA / recency-weighted scoring. Max-over-exemplars is enough for V1.
- Cross-voice contamination detection (warn if two distinct voices' exemplars
  converge).
