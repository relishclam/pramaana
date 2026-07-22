-- ── Fix blockers in pramaana_reset_company_data ───────────────────────────────
-- Migration: 054_reset_rpc_fix_suspense_settlements_fk.sql
--
-- Fix 1 (23503 FK violation on suspense_settlements_settlement_session_id_fkey):
--   Step 2 deleted suspense_settlements only by advance_voucher_id, missing
--   rows linked via settlement_session_id. Now deletes by EITHER FK.
--
-- Fix 2 (P0001 "Cannot delete a posted voucher") /
-- Fix 3 (period lock blocking DELETE) /
-- Fix 4 (TDS challan blocking DELETE):
--   Five BEFORE DELETE trigger functions block deletion of posted /
--   period-locked / challan-complete rows. SET LOCAL session_replication_role
--   was tried but Supabase postgres lacks REPLICATION attribute (42501).
--
--   Solution: custom GUC app.pramaana_reset_bypass.
--   Any role can SET LOCAL "app.*" parameters. Each trigger function checks
--   current_setting('app.pramaana_reset_bypass', true) = 'true' and exits early.
--   SET LOCAL is transaction-scoped; resets automatically on commit/rollback.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Patch trigger functions to honour the bypass GUC ──────────────────────

-- 1a. fn_prevent_posted_edit  (source: 008a_fix_prevent_posted_edit.sql)
CREATE OR REPLACE FUNCTION pramaana.fn_prevent_posted_edit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.pramaana_reset_bypass', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('posted', 'cancelled') THEN
      RAISE EXCEPTION 'Cannot delete a % voucher. Number: %', OLD.status, OLD.voucher_number;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('posted', 'cancelled') THEN
    RAISE EXCEPTION 'Cannot modify a % voucher. Number: %', OLD.status, OLD.voucher_number;
  END IF;
  RETURN NEW;
END;
$$;

-- 1b. fn_check_period_lock  (source: 046_period_lock.sql)
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
  IF current_setting('app.pramaana_reset_bypass', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_company_id   := OLD.company_id;
    v_voucher_date := OLD.voucher_date;
  ELSE
    v_company_id   := NEW.company_id;
    v_voucher_date := NEW.voucher_date;
  END IF;
  SELECT lock_date INTO v_lock_date
  FROM   pramaana.period_locks
  WHERE  company_id = v_company_id
  LIMIT  1;
  IF FOUND AND v_voucher_date <= v_lock_date THEN
    RAISE EXCEPTION
      'Period is locked to %. Vouchers dated on or before this date cannot be created or modified. Unlock in Admin → Period Lock.',
      to_char(v_lock_date, 'DD Mon YYYY');
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- 1c. fn_protect_challan_complete_tds  (source: 049_voucher_tds_deductions.sql)
CREATE OR REPLACE FUNCTION pramaana.fn_protect_challan_complete_tds()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.pramaana_reset_bypass', true) = 'true' THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pramaana.voucher_tds_deductions
    WHERE  voucher_id = OLD.id
      AND  challan_date IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot delete voucher % — it has TDS deduction records with challan details '
      '(TDS already deposited to the government). '
      'Contact your CA before removing this voucher.',
      OLD.voucher_number
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN OLD;
END;
$$;

-- 1d. prevent_posted_entry_mutation  (source: 044_posted_voucher_immutability.sql)
CREATE OR REPLACE FUNCTION pramaana.prevent_posted_entry_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_voucher_status TEXT;
  v_voucher_number TEXT;
  v_voucher_id     UUID;
BEGIN
  IF current_setting('app.pramaana_reset_bypass', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
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
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- 1e. fn_check_period_lock_entry  (source: 046_period_lock.sql)
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
  IF current_setting('app.pramaana_reset_bypass', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_voucher_id := OLD.voucher_id;
  ELSE
    v_voucher_id := NEW.voucher_id;
  END IF;
  SELECT company_id, voucher_date
  INTO   v_company_id, v_voucher_date
  FROM   pramaana.vouchers
  WHERE  id = v_voucher_id;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT lock_date INTO v_lock_date
  FROM   pramaana.period_locks
  WHERE  company_id = v_company_id
  LIMIT  1;
  IF FOUND AND v_voucher_date <= v_lock_date THEN
    RAISE EXCEPTION
      'Period is locked to %. Voucher entries dated on or before this date cannot be created or modified. Unlock in Admin → Period Lock.',
      to_char(v_lock_date, 'DD Mon YYYY');
  END IF;
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

  -- For DELETE, return OLD (not NEW — NEW is NULL in DELETE context and
  -- returning NULL would silently suppress the deletion).
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


-- ── 2. Updated reset function ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.pramaana_reset_company_data(p_company_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pramaana, registry
AS $$
DECLARE
  v_is_super_admin  BOOLEAN;
  v_inv_deleted     INT := 0;
  v_settlements_del INT := 0;
  v_sessions_del    INT := 0;
  v_vouchers_del    INT := 0;
  v_ledgers_del     INT := 0;
  v_groups_del      INT := 0;
  v_cc_del          INT := 0;
  v_seq_del         INT := 0;
  v_audit_del       INT := 0;
  v_scans_del       INT := 0;
BEGIN
  -- Security gate: super_admin only
  SELECT is_super_admin INTO v_is_super_admin
    FROM registry.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_is_super_admin, FALSE) THEN
    RAISE EXCEPTION 'Unauthorized: super_admin required';
  END IF;

  -- Guard: company must exist
  IF NOT EXISTS (SELECT 1 FROM registry.companies WHERE id = p_company_id) THEN
    RAISE EXCEPTION 'Company not found: %', p_company_id;
  END IF;

  -- Signal all patched trigger functions to skip immutability / period-lock checks.
  -- SET LOCAL is transaction-scoped; resets automatically on commit/rollback.
  SET LOCAL "app.pramaana_reset_bypass" = 'true';

  -- 1. Inventory valuations
  DELETE FROM pramaana.inventory_valuations WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_inv_deleted = ROW_COUNT;

  -- 2. Suspense settlements
  --    Delete by advance_voucher_id OR settlement_session_id so both FKs
  --    are cleared before we touch settlement_sessions or vouchers.
  DELETE FROM pramaana.suspense_settlements
    WHERE advance_voucher_id IN (
            SELECT id FROM pramaana.vouchers WHERE company_id = p_company_id
          )
       OR settlement_session_id IN (
            SELECT id FROM pramaana.settlement_sessions WHERE company_id = p_company_id
          );
  GET DIAGNOSTICS v_settlements_del = ROW_COUNT;

  -- 3. Settlement sessions
  DELETE FROM pramaana.settlement_sessions WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_sessions_del = ROW_COUNT;

  -- 4a. Voucher entries — explicit deletion BEFORE removing vouchers.
  --     Two-pronged WHERE:
  --       • voucher_id IN company vouchers  → covers all same-company entries
  --       • ledger_id  IN company ledgers   → covers cross-company inter-company
  --         entries (e.g. Company A's voucher references Company B's ledger);
  --         these are missed by the voucher_id filter and would otherwise block
  --         the ledger deletion in step 5 with a 23503 FK violation.
  DELETE FROM pramaana.voucher_entries
    WHERE voucher_id IN (
            SELECT id FROM pramaana.vouchers WHERE company_id = p_company_id
          )
       OR ledger_id IN (
            SELECT id FROM pramaana.ledgers WHERE company_id = p_company_id
          );

  -- 4b. Vouchers (remaining CASCADEs: voucher_attachments, approval_actions,
  --                                    otp_sessions, gst_details, voucher_line_items,
  --                                    voucher_tds_deductions, bill_allocations)
  DELETE FROM pramaana.vouchers WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_vouchers_del = ROW_COUNT;

  -- 5. Company ledgers (non-system)
  DELETE FROM pramaana.ledgers
    WHERE company_id = p_company_id AND is_system = FALSE;
  GET DIAGNOSTICS v_ledgers_del = ROW_COUNT;

  -- 6. Company ledger groups
  DELETE FROM pramaana.ledger_groups WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_groups_del = ROW_COUNT;

  -- 7. Company cost centres (non-system)
  DELETE FROM pramaana.cost_centres
    WHERE company_id = p_company_id AND is_system = FALSE;
  GET DIAGNOSTICS v_cc_del = ROW_COUNT;

  -- 8. Sequence counters
  DELETE FROM registry.sequence_counters WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_seq_del = ROW_COUNT;

  -- 9. Audit log
  DELETE FROM pramaana.audit_log WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_audit_del = ROW_COUNT;

  -- 10. Invoice scans (CASCADE deletes invoice_scan_items)
  DELETE FROM pramaana.invoice_scans WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_scans_del = ROW_COUNT;

  RETURN jsonb_build_object(
    'success',           true,
    'inventory_deleted', v_inv_deleted,
    'vouchers_deleted',  v_vouchers_del,
    'settlements_del',   v_settlements_del,
    'sessions_deleted',  v_sessions_del,
    'ledgers_deleted',   v_ledgers_del,
    'groups_deleted',    v_groups_del,
    'sequences_reset',   v_seq_del,
    'audit_deleted',     v_audit_del,
    'scans_deleted',     v_scans_del
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.pramaana_reset_company_data(UUID) TO authenticated;
