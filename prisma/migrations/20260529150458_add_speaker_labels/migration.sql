-- CreateEnum
CREATE TYPE "TranscriptionMode" AS ENUM ('basic', 'speaker_labeled');

-- CreateEnum
CREATE TYPE "DiarizationStatus" AS ENUM ('none', 'queued', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "InferenceStatus" AS ENUM ('none', 'pending', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "VoiceSampleSource" AS ENUM ('enrolled', 'tagged_from_cluster');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "default_transcription_mode" "TranscriptionMode" NOT NULL DEFAULT 'basic',
ADD COLUMN     "diarization_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "npc_inference_enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "gaming_sessions" ADD COLUMN     "diarization_status" "DiarizationStatus" NOT NULL DEFAULT 'none',
ADD COLUMN     "needs_resummarize" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "npc_inference_status" "InferenceStatus" NOT NULL DEFAULT 'none',
ADD COLUMN     "transcription_mode" "TranscriptionMode" NOT NULL DEFAULT 'basic';

-- AlterTable
ALTER TABLE "transcriptions" ADD COLUMN     "speaker_cluster_id" TEXT;

-- CreateTable
CREATE TABLE "voice_samples" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "audio_path" TEXT NOT NULL,
    "embedding" BYTEA NOT NULL,
    "embedding_model" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "source" "VoiceSampleSource" NOT NULL DEFAULT 'enrolled',
    "original_cluster_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_speaker_clusters" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "cluster_idx" INTEGER NOT NULL,
    "embedding_centroid" BYTEA NOT NULL,
    "snippet_blob_path" TEXT,
    "snippet_expires_at" TIMESTAMP(3),
    "segment_count" INTEGER NOT NULL,
    "total_duration_ms" INTEGER NOT NULL,
    "voice_sample_id" TEXT,
    "display_label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_speaker_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diarization_jobs" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "status" "DiarizationStatus" NOT NULL,
    "aci_resource_id" TEXT,
    "hmac_secret" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "region" TEXT,
    "bypass_budget" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error_message" TEXT,
    "cost_estimate_usd" DECIMAL(65,30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diarization_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_npc_suggestions" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "cluster_id" TEXT NOT NULL,
    "suggested_name" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,

    CONSTRAINT "session_npc_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_samples_member_id_idx" ON "voice_samples"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "voice_samples_member_id_label_key" ON "voice_samples"("member_id", "label");

-- CreateIndex
CREATE INDEX "session_speaker_clusters_voice_sample_id_idx" ON "session_speaker_clusters"("voice_sample_id");

-- CreateIndex
CREATE INDEX "session_speaker_clusters_campaign_id_idx" ON "session_speaker_clusters"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_speaker_clusters_session_id_cluster_idx_key" ON "session_speaker_clusters"("session_id", "cluster_idx");

-- CreateIndex
CREATE INDEX "diarization_jobs_status_idx" ON "diarization_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "session_npc_suggestions_cluster_id_key" ON "session_npc_suggestions"("cluster_id");

-- CreateIndex
CREATE INDEX "transcriptions_speaker_cluster_id_idx" ON "transcriptions"("speaker_cluster_id");

-- AddForeignKey
ALTER TABLE "transcriptions" ADD CONSTRAINT "transcriptions_speaker_cluster_id_fkey" FOREIGN KEY ("speaker_cluster_id") REFERENCES "session_speaker_clusters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_samples" ADD CONSTRAINT "voice_samples_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_speaker_clusters" ADD CONSTRAINT "session_speaker_clusters_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "gaming_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_speaker_clusters" ADD CONSTRAINT "session_speaker_clusters_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_speaker_clusters" ADD CONSTRAINT "session_speaker_clusters_voice_sample_id_fkey" FOREIGN KEY ("voice_sample_id") REFERENCES "voice_samples"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diarization_jobs" ADD CONSTRAINT "diarization_jobs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "gaming_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_npc_suggestions" ADD CONSTRAINT "session_npc_suggestions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "gaming_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_npc_suggestions" ADD CONSTRAINT "session_npc_suggestions_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "session_speaker_clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
