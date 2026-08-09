-- ── 077_allow_utr_on_posted_vouchers.sql ─────────────────────────────────────
--
-- PURPOSE
--   Carve utr_number out of the posted-voucher immutability rule.
--
-- RATIONALE
--   utr_number is reconciliation metadata — it has no effect on double-entry
--   accounting, trial balance, P&L, or GSTR filings.  The UTR sync bridge
--   (scripts/sync_utr.py) must write it to posted vouchers that were approved
--   and paid before the UTR field existed in RA.  All accounting-relevant
--   fields remain fully immutable on posted rows.
--
-- SAFE: CREATE OR REPLACE — idempotent, re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pramaana.prevent_posted_voucher_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- OLD.status = 'posted' means the row was already posted before this UPDATE.
  -- We allow the transition *to* posted (OLD.status ≠ 'posted').
  IF OLD.status = 'posted' THEN

    -- Allow updating utr_number (reconciliation metadata) on a posted voucher,
    -- provided every accounting-relevant field is unchanged.
    IF NEW.utr_number IS DISTINCT FROM OLD.utr_number
       AND NEW.voucher_number      = OLD.voucher_number
       AND NEW.voucher_date        = OLD.voucher_date
       AND NEW.amount              = OLD.amount
       AND NEW.voucher_type_id     = OLD.voucher_type_id
       AND NEW.company_id          = OLD.company_id
       AND NEW.entity_id           IS NOT DISTINCT FROM OLD.entity_id
       AND NEW.narration           IS NOT DISTINCT FROM OLD.narration
       AND NEW.payment_mode        IS NOT DISTINCT FROM OLD.payment_mode
       AND NEW.bank_ledger_id      IS NOT DISTINCT FROM OLD.bank_ledger_id
       AND NEW.cheque_number       IS NOT DISTINCT FROM OLD.cheque_number
       AND NEW.cheque_date         IS NOT DISTINCT FROM OLD.cheque_date
       AND NEW.cost_centre_id      IS NOT DISTINCT FROM OLD.cost_centre_id
       AND NEW.ref_document_number IS NOT DISTINCT FROM OLD.ref_document_number
       AND NEW.ref_document_type   IS NOT DISTINCT FROM OLD.ref_document_type
       AND NEW.needs_approval      = OLD.needs_approval
       AND NEW.status              = OLD.status
    THEN
      RETURN NEW;  -- utr_number-only change: permitted
    END IF;

    RAISE EXCEPTION 'Cannot modify a posted voucher. Number: %', OLD.voucher_number
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger definition is unchanged (CREATE OR REPLACE on the function is enough).
-- Included here for completeness/idempotency.
DROP TRIGGER IF EXISTS trg_prevent_posted_voucher_update ON pramaana.vouchers;
CREATE TRIGGER trg_prevent_posted_voucher_update
  BEFORE UPDATE
  ON pramaana.vouchers
  FOR EACH ROW
  EXECUTE FUNCTION pramaana.prevent_posted_voucher_update();
