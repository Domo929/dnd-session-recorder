-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "campaign_chunks" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "start_time" DOUBLE PRECISION,
    "end_time" DOUBLE PRECISION,
    "speaker_labels" TEXT[],
    "text" TEXT NOT NULL,
    "embedding" vector(768),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_chunks_campaign_id_idx" ON "campaign_chunks"("campaign_id");

-- CreateIndex
CREATE INDEX "campaign_chunks_session_id_idx" ON "campaign_chunks"("session_id");

-- AddForeignKey
ALTER TABLE "campaign_chunks" ADD CONSTRAINT "campaign_chunks_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_chunks" ADD CONSTRAINT "campaign_chunks_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "gaming_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cosine KNN index for RAG retrieval (pgvector HNSW)
CREATE INDEX "campaign_chunks_embedding_idx"
  ON "campaign_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- Full-text search column + index (Part A keyword search)
ALTER TABLE "campaign_chunks"
  ADD COLUMN "text_search" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED;

CREATE INDEX "campaign_chunks_text_search_idx"
  ON "campaign_chunks" USING gin ("text_search");
