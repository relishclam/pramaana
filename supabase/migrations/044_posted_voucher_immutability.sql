-- ── 044_posted_voucher_immutability.sql ──────────────────────────────────────
--
-- PURPOSE
--   Enforce that vouchers in the 'posted' state are immutable.
--   Once posted, neither the voucher row nor its accounting entries may be
--   modified or deleted.  Corrections must be made via a new reversing
--   Journal voucher (Dr/Cr mirror of the original).
--
-- RATIONALE
--   'posted' vouchers are included in all financial reports (Trial Balance,
--   P&L, Balance Sheet) and in GSTR-1 / GSTR-3B filing.  Editing or deleting
--   a posted voucher would silently alter filed or filed-period data.
--   This trigger provides a DB-level backstop independent of application code.
--
-- WHAT IS BLOCKED
--   • Any UPDATE to a pramaana.vouchers row where the EXISTING status = 'posted'
--   • Any UPDATE or DELETE to a pramaana.voucher_entries row whose parent
--     voucher is already 'posted'
--   • Any attempt to INSERT a new entry row against a posted voucher
--
-- WHAT IS ALLOWED
--   • The UPDATE that TRANSITIONS a voucher TO 'posted' (OLD.status ≠ 'posted')
--     — this is the markVoucherPaid() write and must not be blocked.
--   • All operations on vouchers in any other status.
--
-- REVERSAL PATTERN
--   To correct a posted voucher, a data-entry user creates a new Journal
--   voucher with exactly the reversed amounts (all Dr and Cr swapped).
--   Reference the original voucher number in the narration and
--   ref_document_number fields.  The two vouchers net to zero in reports,
--   and a third correcting entry is entered if needed.
--
-- SAFE: CREATE OR REPLACE — idempotent, re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Trigger function: block changes to already-posted voucher rows ─────────

CREATE OR REPLACE FUNCTION pramaana.prevent_posted_voucher_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- OLD.status = 'posted' means the row is ALREADY posted before this update.
  -- We allow the transition *to* posted (OLD.status ≠ 'posted').
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION
      'Voucher % is posted and cannot be modified. '
      'Create a reversing Journal voucher to correct it.',
      OLD.voucher_number
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 2. Trigger on pramaana.vouchers ──────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_prevent_posted_voucher_update ON pramaana.vouchers;

CREATE TRIGGER trg_prevent_posted_voucher_update
  BEFORE UPDATE
  ON pramaana.vouchers
  FOR EACH ROW
  EXECUTE FUNCTION pramaana.prevent_posted_voucher_update();

-- ── 3. Trigger function: block changes to entries of a posted voucher ─────────

CREATE OR REPLACE FUNCTION pramaana.prevent_posted_entry_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_voucher_status TEXT;
  v_voucher_number TEXT;
  v_voucher_id     UUID;
BEGIN
  -- Identify which voucher_id to check based on operation type.
  -- For DELETE the old row is used; for INSERT/UPDATE the new row.
  IF TG_OP = 'DELETE' THEN
    v_voucher_id := OLD.voucher_id;
  ELSE
    v_voucher_id := NEW.voucher_id;
  END IF;

  SELECT status, voucher_number
  INTO   v_voucher_status, v_voucher_number
  FROM   pramaana.vouchers
  WHERE  id = v_voucher_id;

  IF v_voucher_status = 'posted' THEN
    RAISE EXCEPTION
      'Cannot modify entries of posted voucher %. '
      'Create a reversing Journal voucher to correct it.',
      v_voucher_number
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- ── 4. Triggers on pramaana.voucher_entries ───────────────────────────────────

DROP TRIGGER IF EXISTS trg_prevent_posted_entry_insert ON pramaana.voucher_entries;
DROP TRIGGER IF EXISTS trg_prevent_posted_entry_update ON pramaana.voucher_entries;
DROP TRIGGER IF EXISTS trg_prevent_posted_entry_delete ON pramaana.voucher_entries;

CREATE TRIGGER trg_prevent_posted_entry_insert
  BEFORE INSERT
  ON pramaana.voucher_entries
  FOR EACH ROW
  EXECUTE FUNCTION pramaana.prevent_posted_entry_mutation();

CREATE TRIGGER trg_prevent_posted_entry_update
  BEFORE UPDATE
  ON pramaana.voucher_entries
  FOR EACH ROW
  EXECUTE FUNCTION pramaana.prevent_posted_entry_mutation();

CREATE TRIGGER trg_prevent_posted_entry_delete
  BEFORE DELETE
  ON pramaana.voucher_entries
  FOR EACH ROW
  EXECUTE FUNCTION pramaana.prevent_posted_entry_mutation();

-- ── 5. Comments ───────────────────────────────────────────────────────────────

COMMENT ON FUNCTION pramaana.prevent_posted_voucher_update() IS
  'Blocks any UPDATE to a pramaana.vouchers row that is already in ''posted'' status. '
  'The transition TO ''posted'' (OLD.status ≠ ''posted'') is explicitly allowed '
  'so that markVoucherPaid() can complete normally.';

COMMENT ON FUNCTION pramaana.prevent_posted_entry_mutation() IS
  'Blocks INSERT, UPDATE, or DELETE on pramaana.voucher_entries rows whose parent '
  'voucher is already ''posted''.  Ensures the double-entry record is immutable '
  'once the voucher reaches its terminal financial state.';
