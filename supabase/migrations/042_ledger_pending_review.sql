-- ── 042_ledger_pending_review.sql ────────────────────────────────────────────
--
-- Allows accounts-role users to propose new Ledgers and Ledger Groups.
-- New records created by accounts have is_pending_review = true and are
-- visible (and usable in vouchers) immediately, but flagged for Admin review.
-- Admin approves by setting is_pending_review = false.
--
-- Safe: idempotent (ADD COLUMN IF NOT EXISTS)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pramaana.ledger_groups
  ADD COLUMN IF NOT EXISTS is_pending_review BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pramaana.ledgers
  ADD COLUMN IF NOT EXISTS is_pending_review BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN pramaana.ledger_groups.is_pending_review IS
  'true when created by accounts role — Admin must approve before it is considered permanent';

COMMENT ON COLUMN pramaana.ledgers.is_pending_review IS
  'true when created by accounts role — Admin must approve before it is considered permanent';
