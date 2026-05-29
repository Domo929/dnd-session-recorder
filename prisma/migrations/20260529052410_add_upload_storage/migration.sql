-- CreateEnum
CREATE TYPE "UploadStorage" AS ENUM ('local', 'blob');

-- AlterTable
ALTER TABLE "uploads" ADD COLUMN     "audio_expires_at" TIMESTAMP(3),
ADD COLUMN     "storage" "UploadStorage" NOT NULL DEFAULT 'local';

-- Every row that exists when this migration runs predates blob storage and lives
-- on local disk, so the column default of 'local' backfills them correctly with no
-- separate UPDATE. New uploads are inserted with storage='blob' explicitly by the
-- application layer (db.createUpload / createUploadFromBlob), so the 'local' default
-- only ever applies to these pre-existing rows.
