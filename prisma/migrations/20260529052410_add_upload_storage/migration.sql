-- CreateEnum
CREATE TYPE "UploadStorage" AS ENUM ('local', 'blob');

-- AlterTable
ALTER TABLE "uploads" ADD COLUMN     "audio_expires_at" TIMESTAMP(3),
ADD COLUMN     "storage" "UploadStorage" NOT NULL DEFAULT 'blob';

-- Backfill: the column default ('blob') was applied to all pre-existing rows by
-- the ADD COLUMN above. Those rows predate blob storage and still live on local
-- disk, so flip them back to 'local'. New inserts after this migration default to
-- 'blob' via the Prisma schema default.
UPDATE "uploads" SET "storage" = 'local' WHERE "created_at" < NOW();
