#!/usr/bin/env python3
"""Diarization GPU worker (speaker-labels design §4).

Pipeline:
  1. Download the session audio from the read-only SAS URL (AUDIO_URL).
  2. Run pyannote 3.1 speaker diarization + faster-whisper word-level ASR.
  3. Attribute each transcription segment to the dominant diarization speaker
     (by temporal overlap), producing speaker-attributed segments.
  4. Per speaker cluster, compute the mean ECAPA-TDNN (192-dim) embedding.
  5. POST the result JSON to CALLBACK_URL with an `X-Signature` HMAC-SHA256
     header keyed by HMAC_SECRET (hex), then exit.

The payload shape matches the app's zod schema in
`src/lib/diarizationCallback.ts`:
  { clusters: [{ clusterIdx, embeddingCentroid(base64 192*f32 LE),
                 segmentCount, totalDurationMs,
                 representativeStartMs?, representativeEndMs? }],
    segments: [{ startMs, endMs, text, clusterIdx, confidence? }] }

This worker is intended to run on a CUDA GPU Azure Container Instance; it is not
exercised by the app's CI.
"""
import hashlib
import hmac
import json
import os
import sys
import tempfile

import numpy as np
import requests
import torch

EMBEDDING_DIM = 192  # must match src/lib/voiceFingerprint.ts EMBEDDING_DIM
SAMPLE_RATE = 16000


def log(msg: str) -> None:
    print(f"[diarization] {msg}", flush=True)


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        log(f"FATAL: missing required env {name}")
        sys.exit(2)
    return value


def download_audio(url: str, dest: str) -> None:
    log("downloading audio from SAS URL")
    with requests.get(url, stream=True, timeout=300) as resp:
        resp.raise_for_status()
        with open(dest, "wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                fh.write(chunk)


def to_wav_mono16k(src: str, dest: str) -> None:
    """Normalize to mono 16 kHz PCM WAV via ffmpeg for the models."""
    import subprocess

    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-ac", "1", "-ar", str(SAMPLE_RATE), dest],
        check=True,
        capture_output=True,
    )


def run_diarization(wav_path: str):
    """Return a list of (start_s, end_s, speaker_label) turns."""
    from pyannote.audio import Pipeline

    token = os.environ.get("HUGGINGFACE_TOKEN")
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1", use_auth_token=token
    )
    if torch.cuda.is_available():
        pipeline.to(torch.device("cuda"))

    annotation = pipeline(wav_path)
    turns = []
    for segment, _, speaker in annotation.itertracks(yield_label=True):
        turns.append((segment.start, segment.end, speaker))
    return turns


def run_transcription(wav_path: str):
    """Return a list of segments with word-level timing from faster-whisper."""
    from faster_whisper import WhisperModel

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    model = WhisperModel("large-v3", device=device, compute_type=compute_type)

    segments, _ = model.transcribe(wav_path, word_timestamps=True)
    out = []
    for seg in segments:
        out.append(
            {
                "start": seg.start,
                "end": seg.end,
                "text": seg.text.strip(),
                "confidence": _avg_word_prob(seg),
            }
        )
    return out


def _avg_word_prob(seg) -> float:
    words = getattr(seg, "words", None) or []
    probs = [w.probability for w in words if getattr(w, "probability", None) is not None]
    if not probs:
        return 1.0
    return float(sum(probs) / len(probs))


def dominant_speaker(turns, start_s: float, end_s: float):
    """The diarization speaker with the most temporal overlap of [start,end]."""
    best_label, best_overlap = None, 0.0
    for t_start, t_end, label in turns:
        overlap = max(0.0, min(end_s, t_end) - max(start_s, t_start))
        if overlap > best_overlap:
            best_overlap, best_label = overlap, label
    return best_label


def load_ecapa():
    from speechbrain.inference.speaker import EncoderClassifier

    run_opts = {"device": "cuda"} if torch.cuda.is_available() else {"device": "cpu"}
    return EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir="/models/ecapa",
        run_opts=run_opts,
    )


def cluster_embedding(classifier, wav_tensor, turns_for_speaker) -> np.ndarray:
    """Mean ECAPA embedding over a speaker's turns (concatenated audio)."""
    pieces = []
    for t_start, t_end in turns_for_speaker:
        s = int(t_start * SAMPLE_RATE)
        e = int(t_end * SAMPLE_RATE)
        if e > s:
            pieces.append(wav_tensor[:, s:e])
    if not pieces:
        return np.zeros(EMBEDDING_DIM, dtype=np.float32)
    audio = torch.cat(pieces, dim=1)
    with torch.no_grad():
        emb = classifier.encode_batch(audio).squeeze().detach().cpu().numpy()
    return emb.astype(np.float32).reshape(-1)[:EMBEDDING_DIM]


def encode_embedding(vec: np.ndarray) -> str:
    """192 float32 little-endian, base64 — matches serializeEmbedding()."""
    if vec.shape[0] != EMBEDDING_DIM:
        padded = np.zeros(EMBEDDING_DIM, dtype=np.float32)
        padded[: min(EMBEDDING_DIM, vec.shape[0])] = vec[:EMBEDDING_DIM]
        vec = padded
    import base64

    return base64.b64encode(vec.astype("<f4").tobytes()).decode("ascii")


def build_payload(turns, segments, classifier, wav_tensor) -> dict:
    # Stable integer cluster indices from the diarization speaker labels.
    labels = sorted({label for _, _, label in turns})
    label_to_idx = {label: i for i, label in enumerate(labels)}

    out_segments = []
    for seg in segments:
        label = dominant_speaker(turns, seg["start"], seg["end"])
        if label is None or not seg["text"]:
            continue
        out_segments.append(
            {
                "startMs": int(seg["start"] * 1000),
                "endMs": int(seg["end"] * 1000),
                "text": seg["text"],
                "clusterIdx": label_to_idx[label],
                "confidence": round(float(seg["confidence"]), 4),
            }
        )

    clusters = []
    for label, idx in label_to_idx.items():
        speaker_turns = [(s, e) for s, e, l in turns if l == label]
        total_ms = int(sum(e - s for s, e in speaker_turns) * 1000)
        seg_count = sum(1 for s in out_segments if s["clusterIdx"] == idx)
        rep = max(speaker_turns, key=lambda t: t[1] - t[0]) if speaker_turns else None
        emb = cluster_embedding(classifier, wav_tensor, speaker_turns)
        cluster = {
            "clusterIdx": idx,
            "embeddingCentroid": encode_embedding(emb),
            "segmentCount": seg_count,
            "totalDurationMs": total_ms,
        }
        if rep is not None:
            cluster["representativeStartMs"] = int(rep[0] * 1000)
            cluster["representativeEndMs"] = int(rep[1] * 1000)
        clusters.append(cluster)

    return {"clusters": clusters, "segments": out_segments}


def post_callback(url: str, secret_hex: str, payload: dict) -> None:
    body = json.dumps(payload, separators=(",", ":"))
    signature = hmac.new(
        bytes.fromhex(secret_hex), body.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    log(f"posting callback ({len(payload['clusters'])} clusters, "
        f"{len(payload['segments'])} segments)")
    resp = requests.post(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Signature": f"sha256={signature}",
        },
        timeout=120,
    )
    resp.raise_for_status()
    log(f"callback accepted: HTTP {resp.status_code}")


def main() -> None:
    job_id = require_env("JOB_ID")
    audio_url = require_env("AUDIO_URL")
    callback_url = require_env("CALLBACK_URL")
    hmac_secret = require_env("HMAC_SECRET")
    log(f"starting job {job_id}")

    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, "audio.in")
        wav = os.path.join(tmp, "audio.wav")
        download_audio(audio_url, raw)
        to_wav_mono16k(raw, wav)

        log("running diarization")
        turns = run_diarization(wav)
        log(f"diarization produced {len(turns)} turns")

        log("running transcription")
        segments = run_transcription(wav)
        log(f"transcription produced {len(segments)} segments")

        import soundfile as sf

        data, _ = sf.read(wav, dtype="float32")
        wav_tensor = torch.from_numpy(np.asarray(data)).reshape(1, -1)

        classifier = load_ecapa()
        payload = build_payload(turns, segments, classifier, wav_tensor)

    post_callback(callback_url, hmac_secret, payload)
    log("done")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — top-level guard; container exits non-zero.
        log(f"FATAL: {exc}")
        sys.exit(1)
