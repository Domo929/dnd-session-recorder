-- AlterTable
ALTER TABLE "gaming_sessions" ADD COLUMN     "transcription_chunk_count" INTEGER;

-- CreateTable
CREATE TABLE "transcription_chunks" (
    "id" SERIAL NOT NULL,
    "session_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcription_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transcription_chunks_session_id_idx" ON "transcription_chunks"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "transcription_chunks_session_id_chunk_index_key" ON "transcription_chunks"("session_id", "chunk_index");

-- AddForeignKey
ALTER TABLE "transcription_chunks" ADD CONSTRAINT "transcription_chunks_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "gaming_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
