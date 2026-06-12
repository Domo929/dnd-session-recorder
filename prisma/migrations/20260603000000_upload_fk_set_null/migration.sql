-- Deleting an Upload must NOT delete the GamingSession that references it.
-- The previous migration (add_user_id_to_gaming_sessions) inadvertently
-- regenerated this foreign key with ON DELETE CASCADE, so reconciling/deleting
-- an upload cascade-deleted the whole session. Restore ON DELETE SET NULL so the
-- session survives and simply loses its upload link.
ALTER TABLE "gaming_sessions" DROP CONSTRAINT "gaming_sessions_upload_id_fkey";

ALTER TABLE "gaming_sessions" ADD CONSTRAINT "gaming_sessions_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
