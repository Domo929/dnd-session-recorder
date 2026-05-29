# Diarization GPU container

Speaker-labels diarization worker (design §4 of
`docs/plans/2026-05-27-speaker-labels-design.md`). It is launched, one instance
per session, by the **in-app dispatcher** (`src/services/diarization/`) on a GPU
Azure Container Instance.

## What it does

1. Downloads the session audio from a short-lived read-only Blob **SAS URL**
   (`AUDIO_URL`).
2. Runs **pyannote 3.1** speaker diarization and **faster-whisper** word-level
   transcription.
3. Attributes each transcription segment to the dominant diarization speaker by
   temporal overlap.
4. Computes a per-speaker mean **ECAPA-TDNN** embedding (192-dim, matching
   `EMBEDDING_DIM` in `src/lib/voiceFingerprint.ts`).
5. POSTs the result to `CALLBACK_URL` with an `X-Signature: sha256=<hmac>`
   header (HMAC-SHA256 of the raw body, keyed by `HMAC_SECRET` as hex), then
   exits. The container group (restartPolicy=Never) auto-terminates.

## Environment variables (set by the dispatcher)

| Var            | Purpose                                                        |
| -------------- | -------------------------------------------------------------- |
| `JOB_ID`       | Diarization job id (also the callback path segment).           |
| `AUDIO_URL`    | Read-only Blob SAS URL for the session audio (valid ~2 h).     |
| `CALLBACK_URL` | `.../api/diarization/callback/<jobId>` to POST results to.     |
| `HMAC_SECRET`  | Per-job secret (hex) used to sign the callback body.           |
| `HUGGINGFACE_TOKEN` | (optional) HF token for gated pyannote model download.    |

## Callback payload

Matches the zod schema in `src/lib/diarizationCallback.ts`:

```jsonc
{
  "clusters": [
    {
      "clusterIdx": 0,
      "embeddingCentroid": "<base64 of 192 float32 little-endian>",
      "segmentCount": 12,
      "totalDurationMs": 84000,
      "representativeStartMs": 12000,
      "representativeEndMs": 18000
    }
  ],
  "segments": [
    { "startMs": 0, "endMs": 4200, "text": "...", "clusterIdx": 0, "confidence": 0.93 }
  ]
}
```

## Build & publish

This image needs a CUDA GPU host and is **not** built by the app's CI. It is
built and pushed to `ghcr.io/domo929/dnd-recorder-diarization:latest` from the
deploy repo (`Domo929/dnd-recorder-deploy`).

```bash
docker build -t ghcr.io/domo929/dnd-recorder-diarization:latest docker/diarization
docker push ghcr.io/domo929/dnd-recorder-diarization:latest
```

## Local manual test

```bash
docker run --gpus all --rm \
  -e JOB_ID=test \
  -e AUDIO_URL="https://.../audio.m4a?<sas>" \
  -e CALLBACK_URL="https://host.docker.internal:3000/api/diarization/callback/test" \
  -e HMAC_SECRET="<hex secret matching the job row>" \
  ghcr.io/domo929/dnd-recorder-diarization:latest
```

## Deploy-repo responsibilities

ACI is launched by the app via managed identity. The deploy repo
(`Domo929/dnd-recorder-deploy`) owns: the GPU ACI RBAC grant for the App Service
managed identity, the `voice-samples` blob container, and the dispatcher env
vars (`DIARIZATION_IMAGE`, `AZURE_SUBSCRIPTION_ID`,
`DIARIZATION_ACI_RESOURCE_GROUP`, `DIARIZATION_CALLBACK_BASE_URL`, regions and
cost guardrails). See `env.example`.
