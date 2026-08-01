-- ── 064_bank_statements_raw_content.sql ─────────────────────────────────────
-- Purpose : Eliminate Supabase Storage bucket dependency for bank statement
--           uploads. Store raw file content (base64) directly in the table.
--           storage_path made optional (kept for future bucket migration).
-- Safe    : Idempotent — ADD COLUMN IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pramaana.bank_statements
  ADD COLUMN IF NOT EXISTS raw_content text,        -- base64-encoded file bytes
  ALTER COLUMN storage_path DROP NOT NULL;          -- no longer required

COMMENT ON COLUMN pramaana.bank_statements.raw_content IS
  'Base64-encoded original file bytes. Replaces Supabase Storage bucket upload.';
