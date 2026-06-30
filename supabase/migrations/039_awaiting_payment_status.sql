-- ── Awaiting Payment Status + Queue Audit Columns ─────────────────────────────
-- Purpose : Add formal awaiting_payment status between completed → posted,
--           with queue audit trail columns
-- NOTE    : The CHECK constraint was already applied manually on 2026-06-30.
--           Only the ADD COLUMN statements need to be run if not already done.
-- Safe    : Idempotent (ADD COLUMN IF NOT EXISTS)
-- ─────────────────────────────────────────────────────────────────────────────

-- Status constraint — already applied; kept here for migration history
ALTER TABLE pramaana.vouchers
  DROP CONSTRAINT IF EXISTS vouchers_status_check;

ALTER TABLE pramaana.vouchers
  ADD CONSTRAINT vouchers_status_check
  CHECK (status IN (
    'draft', 'pending_approval', 'approved', 'completed',
    'awaiting_payment', 'posted', 'cancelled'
  ));

-- Queue audit columns (run these if not yet applied)
ALTER TABLE pramaana.vouchers
  ADD COLUMN IF NOT EXISTS queued_at                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS queued_for_payment_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN pramaana.vouchers.queued_at IS
  'Timestamp when Accounts queued this voucher for payment (completed → awaiting_payment)';

COMMENT ON COLUMN pramaana.vouchers.queued_for_payment_by IS
  'User who queued the voucher for payment';
