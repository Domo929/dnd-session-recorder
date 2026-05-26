-- Hand-written migration: preserves existing campaign data by renaming
-- user_id -> created_by and switching the foreign key from CASCADE to RESTRICT.
-- See docs/plans/2026-05-26-campaign-sharing-impl.md (Task 1.2) for context.

-- Drop the old FK and unique index that referenced user_id
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_user_id_fkey";
DROP INDEX "campaigns_user_id_name_key";

-- Rename the column (preserves data)
ALTER TABLE "campaigns" RENAME COLUMN "user_id" TO "created_by";

-- CreateTable
CREATE TABLE "members" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "invited_by" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_links" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "invite_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "invited_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "members_user_id_idx" ON "members"("user_id");

-- CreateIndex
CREATE INDEX "members_campaign_id_role_idx" ON "members"("campaign_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "members_campaign_id_user_id_key" ON "members"("campaign_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invite_links_token_hash_key" ON "invite_links"("token_hash");

-- CreateIndex
CREATE INDEX "invite_links_campaign_id_idx" ON "invite_links"("campaign_id");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_campaign_id_email_key" ON "invitations"("campaign_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_created_by_name_key" ON "campaigns"("created_by", "name");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed: backfill members for every existing campaign so the creator retains owner access
INSERT INTO "members" ("id", "campaign_id", "user_id", "role", "invited_by", "joined_at")
SELECT
    'mig_' || "id",
    "id",
    "created_by",
    'owner',
    NULL,
    "created_at"
FROM "campaigns";
