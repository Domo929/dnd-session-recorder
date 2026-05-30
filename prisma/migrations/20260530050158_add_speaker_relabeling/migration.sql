-- CreateTable
CREATE TABLE "session_speaker_defaults" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "speaker_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_speaker_defaults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_speaker_turns" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "turn_index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_speaker_turns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_speaker_defaults_campaign_id_idx" ON "session_speaker_defaults"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_speaker_defaults_session_id_speaker_key_key" ON "session_speaker_defaults"("session_id", "speaker_key");

-- CreateIndex
CREATE INDEX "session_speaker_turns_campaign_id_idx" ON "session_speaker_turns"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_speaker_turns_session_id_turn_index_key" ON "session_speaker_turns"("session_id", "turn_index");

-- AddForeignKey
ALTER TABLE "session_speaker_defaults" ADD CONSTRAINT "session_speaker_defaults_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "gaming_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_speaker_turns" ADD CONSTRAINT "session_speaker_turns_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "gaming_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

