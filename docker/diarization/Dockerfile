# syntax=docker/dockerfile:1
#
# Diarization GPU container (speaker-labels design §4).
#
# Pulls a session's audio from a read-only SAS URL, runs pyannote 3.1 speaker
# diarization + faster-whisper word-level transcription, computes a per-cluster
# mean ECAPA-TDNN speaker embedding, and POSTs the result to the app's callback
# endpoint signed with an HMAC-SHA256 of the request body.
#
# Image is published (by the deploy repo / CI, NOT this app repo) to
# ghcr.io/domo929/dnd-recorder-diarization:latest and launched on a GPU Azure
# Container Instance by the in-app dispatcher.
#
# NOTE: this image is NOT built or exercised by the app's CI; it needs a CUDA
# GPU host. Build/run it in the diarization/deploy environment.

FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models/hf \
    TORCH_HOME=/models/torch

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

COPY entrypoint.py ./

# Container groups use restartPolicy=Never; the process exits after POSTing.
ENTRYPOINT ["python3", "/app/entrypoint.py"]
