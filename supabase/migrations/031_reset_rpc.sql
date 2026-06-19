-- ── Super-Admin Reset + Import Helpers ────────────────────────────────────────
-- Purpose : Full company data wipe for pre-go-live test cycles.
--           Super-Admin only (checked inside the function).
--           Import helpers: upsert ledger groups + ledgers from CSV.
-- Run in  : Supabase SQL editor → project mmkbknnzgpvsqgnynrbe
-- Safe    : CREATE OR REPLACE; DROP TRIGGER IF EXISTS; idempotent
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Reset function ─────────────────────────────────────────────────────────
-- Clears all company-scoped accounting data. Preserves:
--   • registry.companies / profiles / company_users
--   • System ledger groups (company_id IS NULL)
--   • pramaana.voucher_types
--   • pramaana.cost_centres where is_system = TRUE (CW_DIV)
--   • registry.entities / entity_roles

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

  -- 1. Inventory valuations (no FK dependencies)
  DELETE FROM pramaana.inventory_valuations WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_inv_deleted = ROW_COUNT;

  -- 2. Suspense settlements (FK → vouchers with no CASCADE — must delete before vouchers)
  DELETE FROM pramaana.suspense_settlements
    WHERE advance_voucher_id IN (
      SELECT id FROM pramaana.vouchers WHERE company_id = p_company_id
    );
  GET DIAGNOSTICS v_settlements_del = ROW_COUNT;

  -- 3. Settlement sessions (FK advance_voucher_id → vouchers ON DELETE SET NULL — safe either way)
  DELETE FROM pramaana.settlement_sessions WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_sessions_del = ROW_COUNT;

  -- 4. Vouchers (CASCADEs: voucher_entries, voucher_attachments, approval_actions,
  --                         otp_sessions, gst_details, voucher_line_items)
  DELETE FROM pramaana.vouchers WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_vouchers_del = ROW_COUNT;

  -- 5. Company ledgers (non-system)
  DELETE FROM pramaana.ledgers
    WHERE company_id = p_company_id AND is_system = FALSE;
  GET DIAGNOSTICS v_ledgers_del = ROW_COUNT;

  -- 6. Company ledger groups (all company-scoped groups)
  DELETE FROM pramaana.ledger_groups WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_groups_del = ROW_COUNT;

  -- 7. Company cost centres (non-system — keeps CW_DIV)
  DELETE FROM pramaana.cost_centres
    WHERE company_id = p_company_id AND is_system = FALSE;
  GET DIAGNOSTICS v_cc_del = ROW_COUNT;

  -- 8. Sequence counters
  DELETE FROM registry.sequence_counters WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_seq_del = ROW_COUNT;

  -- 9. Audit log
  DELETE FROM pramaana.audit_log WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_audit_del = ROW_COUNT;

  RETURN jsonb_build_object(
    'success',           true,
    'inventory_deleted', v_inv_deleted,
    'vouchers_deleted',  v_vouchers_del,
    'settlements_del',   v_settlements_del,
    'sessions_deleted',  v_sessions_del,
    'ledgers_deleted',   v_ledgers_del,
    'groups_deleted',    v_groups_del,
    'sequences_reset',   v_seq_del,
    'audit_deleted',     v_audit_del
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.pramaana_reset_company_data(UUID) TO authenticated;

-- ── 2. Count helper (shown to user BEFORE they confirm reset) ─────────────────

CREATE OR REPLACE FUNCTION public.pramaana_reset_preview(p_company_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pramaana, registry
AS $$
DECLARE
  v_is_super_admin BOOLEAN;
  v_vouchers   BIGINT;
  v_ledgers    BIGINT;
  v_groups     BIGINT;
  v_sessions   BIGINT;
BEGIN
  SELECT is_super_admin INTO v_is_super_admin
    FROM registry.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_is_super_admin, FALSE) THEN
    RAISE EXCEPTION 'Unauthorized: super_admin required';
  END IF;

  SELECT COUNT(*) INTO v_vouchers FROM pramaana.vouchers     WHERE company_id = p_company_id;
  SELECT COUNT(*) INTO v_ledgers  FROM pramaana.ledgers      WHERE company_id = p_company_id AND is_system = FALSE;
  SELECT COUNT(*) INTO v_groups   FROM pramaana.ledger_groups WHERE company_id = p_company_id;
  SELECT COUNT(*) INTO v_sessions FROM pramaana.settlement_sessions WHERE company_id = p_company_id;

  RETURN jsonb_build_object(
    'vouchers', v_vouchers,
    'ledgers',  v_ledgers,
    'groups',   v_groups,
    'sessions', v_sessions
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.pramaana_reset_preview(UUID) TO authenticated;
