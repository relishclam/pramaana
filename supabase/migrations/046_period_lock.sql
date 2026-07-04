-- ── Period Lock ───────────────────────────────────────────────────────────────
-- Migration: 046_period_lock.sql
-- Purpose: Prevent any voucher create/edit/delete for dates on or before a
--          company's lock date (protects filed tax periods from accidental edits).
--
-- Design:
--   - pramaana.period_locks  — one row per company; stores the lock date + who set it
--   - fn_check_period_lock() — BEFORE trigger fired on vouchers table; raises exception
--     if the operation touches a voucher dated within the locked period
--
-- Usage:
--   - Admin Panel → Period Lock → pick a date → Lock
--   - To correct an error: unlock, make the fix, re-lock
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Period locks table ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.period_locks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL,   -- references registry.companies(id) — no FK (cross-schema)
  lock_date   DATE        NOT NULL,   -- vouchers ON OR BEFORE this date are locked
  locked_by   UUID        NOT NULL REFERENCES auth.users(id),
  locked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT,                   -- optional: "Q4 FY2526 GST filed", etc.
  UNIQUE (company_id)                 -- one active lock per company; UPDATE to move date
);

-- Idempotent column additions: handles re-run when the table was previously
-- created by an earlier partial migration with a different schema.
ALTER TABLE pramaana.period_locks
  ADD COLUMN IF NOT EXISTS lock_date  DATE        DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS locked_by  UUID        REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS locked_at  TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS note       TEXT;

-- Enforce NOT NULL on lock_date (safe: no existing data rows expected)
ALTER TABLE pramaana.period_locks
  ALTER COLUMN lock_date SET NOT NULL;

-- Remove the temporary default now that NOT NULL is set
ALTER TABLE pramaana.period_locks
  ALTER COLUMN lock_date DROP DEFAULT;

-- Ensure the unique constraint exists (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'pramaana.period_locks'::regclass
      AND contype = 'u'
      AND conname LIKE '%company_id%'
  ) THEN
    ALTER TABLE pramaana.period_locks ADD CONSTRAINT period_locks_company_id_key UNIQUE (company_id);
  END IF;
END $$;

ALTER TABLE pramaana.period_locks ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read (to show lock status in the UI)
DROP POLICY IF EXISTS period_locks_read  ON pramaana.period_locks;
DROP POLICY IF EXISTS period_locks_write ON pramaana.period_locks;
CREATE POLICY period_locks_read ON pramaana.period_locks
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users WHERE user_id = auth.uid()
    )
  );

-- Only super_admin can insert/update/delete
CREATE POLICY period_locks_write ON pramaana.period_locks
  FOR ALL TO authenticated
  USING  (registry.is_super_admin())
  WITH CHECK (registry.is_super_admin());

COMMENT ON TABLE pramaana.period_locks IS
  'One row per company. Vouchers dated on or before lock_date cannot be '
  'created, modified, or deleted. Remove the row to unlock.';

COMMENT ON COLUMN pramaana.period_locks.lock_date IS
  'All pramaana.vouchers with voucher_date <= lock_date are immutable.';

-- ── 2. Trigger function ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pramaana.fn_check_period_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pramaana, registry, public
AS $$
DECLARE
  v_company_id   UUID;
  v_voucher_date DATE;
  v_lock_date    DATE;
BEGIN
  -- Resolve company + date from the correct record
  IF TG_OP = 'DELETE' THEN
    v_company_id   := OLD.company_id;
    v_voucher_date := OLD.voucher_date;
  ELSE
    v_company_id   := NEW.company_id;
    v_voucher_date := NEW.voucher_date;
  END IF;

  -- Check for an active lock
  SELECT lock_date INTO v_lock_date
  FROM   pramaana.period_locks
  WHERE  company_id = v_company_id
  LIMIT  1;

  IF FOUND AND v_voucher_date <= v_lock_date THEN
    RAISE EXCEPTION
      'Period is locked to %. Vouchers dated on or before this date cannot be created or modified. Unlock in Admin → Period Lock.',
      to_char(v_lock_date, 'DD Mon YYYY');
  END IF;

  -- Allow the operation
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- ── 3. Attach trigger to vouchers ─────────────────────────────────────────────
-- Fires BEFORE INSERT, UPDATE, DELETE so the operation is blocked before any
-- row is written. Must come AFTER the existing immutability triggers so the
-- error message is clear (though order doesn't matter functionally here).

DROP TRIGGER IF EXISTS trg_period_lock    ON pramaana.vouchers;
DROP TRIGGER IF EXISTS trg_00_period_lock ON pramaana.vouchers;

CREATE TRIGGER trg_00_period_lock
BEFORE INSERT OR UPDATE OR DELETE
ON pramaana.vouchers
FOR EACH ROW
EXECUTE FUNCTION pramaana.fn_check_period_lock();

-- Trigger name starts with '0' so it fires alphabetically BEFORE
-- trg_prevent_posted_voucher_update (migration 044, starts with 't').
-- The period-lock error is the one the user should see first.

-- Grant execute on the function to PostgREST roles
GRANT EXECUTE ON FUNCTION pramaana.fn_check_period_lock() TO authenticated, service_role;

-- ── 4. Also cover pramaana.voucher_entries ────────────────────────────────────
-- Without this, a direct INSERT/UPDATE/DELETE on a voucher_entries row whose
-- parent voucher is dated before the lock bypasses the voucher-level trigger
-- entirely.  voucher_entries has no company_id/voucher_date columns of its own,
-- so the check must JOIN back to pramaana.vouchers.
--
-- ON DELETE CASCADE interaction: deleting a locked voucher fires the
-- voucher-level trg_00_period_lock first (alphabetically earlier), which raises
-- before the cascade propagates — so the cascade never reaches voucher_entries.
-- The entry-level trigger here covers direct entry mutations only.

CREATE OR REPLACE FUNCTION pramaana.fn_check_period_lock_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pramaana, registry, public
AS $$
DECLARE
  v_company_id   UUID;
  v_voucher_date DATE;
  v_lock_date    DATE;
  v_voucher_id   UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_voucher_id := OLD.voucher_id;
  ELSE
    v_voucher_id := NEW.voucher_id;
  END IF;

  -- Resolve company + date from parent voucher (new parent on INSERT/UPDATE)
  SELECT company_id, voucher_date
  INTO   v_company_id, v_voucher_date
  FROM   pramaana.vouchers
  WHERE  id = v_voucher_id;

  IF NOT FOUND THEN
    -- Orphaned entry (parent already deleted) — allow the delete to proceed
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- Check for an active lock against the new/target voucher
  SELECT lock_date INTO v_lock_date
  FROM   pramaana.period_locks
  WHERE  company_id = v_company_id
  LIMIT  1;

  IF FOUND AND v_voucher_date <= v_lock_date THEN
    RAISE EXCEPTION
      'Period is locked to %. Voucher entries dated on or before this date cannot be created or modified. Unlock in Admin → Period Lock.',
      to_char(v_lock_date, 'DD Mon YYYY');
  END IF;

  -- On UPDATE: also check the OLD parent voucher when voucher_id is being changed.
  -- This prevents silently detaching an entry from a locked voucher by moving it
  -- to a different (unlocked) voucher_id.
  IF TG_OP = 'UPDATE' AND OLD.voucher_id IS DISTINCT FROM NEW.voucher_id THEN
    DECLARE
      v_old_company_id   UUID;
      v_old_voucher_date DATE;
      v_old_lock_date    DATE;
    BEGIN
      SELECT company_id, voucher_date
      INTO   v_old_company_id, v_old_voucher_date
      FROM   pramaana.vouchers
      WHERE  id = OLD.voucher_id;

      IF FOUND THEN
        SELECT lock_date INTO v_old_lock_date
        FROM   pramaana.period_locks
        WHERE  company_id = v_old_company_id
        LIMIT  1;

        IF FOUND AND v_old_voucher_date <= v_old_lock_date THEN
          RAISE EXCEPTION
            'Period is locked to %. Cannot detach an entry from a voucher dated on or before this date. Unlock in Admin → Period Lock.',
            to_char(v_old_lock_date, 'DD Mon YYYY');
        END IF;
      END IF;
    END;
  END IF;

  RETURN NEW;
END;
$$;

-- Names start with '0' to fire before trg_prevent_posted_entry_* (starts with 't').
DROP TRIGGER IF EXISTS trg_00_period_lock_entry_insert ON pramaana.voucher_entries;
DROP TRIGGER IF EXISTS trg_00_period_lock_entry_update ON pramaana.voucher_entries;
DROP TRIGGER IF EXISTS trg_00_period_lock_entry_delete ON pramaana.voucher_entries;

CREATE TRIGGER trg_00_period_lock_entry_insert
  BEFORE INSERT ON pramaana.voucher_entries
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_check_period_lock_entry();

CREATE TRIGGER trg_00_period_lock_entry_update
  BEFORE UPDATE ON pramaana.voucher_entries
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_check_period_lock_entry();

CREATE TRIGGER trg_00_period_lock_entry_delete
  BEFORE DELETE ON pramaana.voucher_entries
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_check_period_lock_entry();

GRANT EXECUTE ON FUNCTION pramaana.fn_check_period_lock_entry() TO authenticated, service_role;

-- ── Design decisions documented ───────────────────────────────────────────────
-- service_role bypass: deliberately NONE. No escape hatch exists at the DB
--   level. The operational consequence is a company-wide unlock/fix/relock
--   cycle — there is no scoped single-voucher override.
--
-- Operational runbook (expected during Tally cutover, ~Jul 31 2026):
--   If a data integrity issue (e.g. debits ≠ credits on a posted voucher)
--   is discovered during pre-flight validation after the period is locked:
--     1. super_admin deletes the lock row (Admin → Period Lock → Unlock).
--        ALL vouchers for that company are now editable.
--     2. Make the targeted correction.
--     3. Re-lock immediately with the same or updated lock_date.
--   This is the intended flow. There is no scoped unlock for a single voucher.
--   The window of exposure is the time between step 1 and step 3 — keep it
--   short and note who performed the unlock in the lock.note field on re-lock.
--
-- status='posted' coverage (confirmed Jul 2026):
--   approveVoucher() sets: payment → 'approved'; ALL OTHER NATURES → 'posted'.
--   Payment vouchers reach 'posted' via markVoucherPaid() at the end of the
--   Pay Now flow. Every voucher nature therefore has a reachable 'posted' state.
--   Migration 044 (prevent_posted_voucher_update + prevent_posted_entry_mutation)
--   is correctly covering all natures.
--
-- voucher_id UPDATE edge case:
--   fn_check_period_lock_entry checks BOTH the new and old parent voucher when
--   voucher_id changes on UPDATE, preventing silent detachment of entries from
--   a locked voucher by reassigning them to a different (unlocked) one.
--   Normal app flows never change voucher_id on existing entries — this guard
--   covers direct DB manipulation only.
--
-- Audit trail: this migration stores a single mutable row per company.
--   Unlock/relock cycles lose history. A future period_lock_history table
--   (append-only, one row per lock/unlock event) would provide full audit
--   visibility but is deferred — not required for July 31 cutover.
