-- ====================================================================
-- PRAMAANA CLEANUP: Remove trial bank account ledgers
-- ====================================================================
--
-- Removes 4 development/trial bank ledger entries:
--   RFPL : "Bank Account (RFPL)"           → reassign entries → Canara Bank
--   RFPL : "Cannara Bank"  (misspelled)    → reassign entries → Canara Bank
--   RHHF : "Bank Account (RHHF)"           → reassign entries → HDFC Current
--   RHHF : "SBI Current Account"           → reassign entries → HDFC Current
--
-- Safe to run multiple times (idempotent — trial ledgers already gone = no-op).
--
-- Run in: Pramaana Supabase (mmkbknnzgpvsqgnynrbe) → SQL Editor
-- ====================================================================

DO $cleanup$
DECLARE
  v_rfpl        UUID;
  v_rhhf        UUID;

  -- Real bank ledgers (created by 042)
  v_canara      UUID;
  v_hdfc        UUID;

  -- Trial ledgers
  v_rfpl_trial  UUID;
  v_cannara     UUID;
  v_rhhf_trial  UUID;
  v_sbi         UUID;

  n_ve_updated  INT;
  n_vou_updated INT;
BEGIN
  SELECT id INTO v_rfpl FROM registry.companies WHERE code = 'RFPL';
  SELECT id INTO v_rhhf FROM registry.companies WHERE code = 'RHHF';

  -- Real target bank ledgers
  SELECT id INTO v_canara FROM pramaana.ledgers
    WHERE company_id = v_rfpl AND name = 'Canara Bank';
  SELECT id INTO v_hdfc   FROM pramaana.ledgers
    WHERE company_id = v_rhhf AND name = 'HDFC Bank Ltd - Current Account';

  IF v_canara IS NULL THEN RAISE EXCEPTION 'Canara Bank ledger not found — run 042 first'; END IF;
  IF v_hdfc   IS NULL THEN RAISE EXCEPTION 'HDFC Bank ledger not found — run 042 first';   END IF;

  -- Trial ledger IDs (may be NULL if already deleted — no-op)
  SELECT id INTO v_rfpl_trial FROM pramaana.ledgers WHERE company_id = v_rfpl AND name = 'Bank Account (RFPL)';
  SELECT id INTO v_cannara    FROM pramaana.ledgers WHERE company_id = v_rfpl AND name = 'Cannara Bank';
  SELECT id INTO v_rhhf_trial FROM pramaana.ledgers WHERE company_id = v_rhhf AND name = 'Bank Account (RHHF)';
  SELECT id INTO v_sbi        FROM pramaana.ledgers WHERE company_id = v_rhhf AND name = 'SBI Current Account';

  -- ── RFPL: Bank Account (RFPL) ───────────────────────────────────
  IF v_rfpl_trial IS NOT NULL THEN
    -- voucher_entries
    UPDATE pramaana.voucher_entries SET ledger_id = v_canara
      WHERE ledger_id = v_rfpl_trial;
    GET DIAGNOSTICS n_ve_updated = ROW_COUNT;

    -- vouchers.bank_ledger_id
    UPDATE pramaana.vouchers SET bank_ledger_id = v_canara
      WHERE company_id = v_rfpl AND bank_ledger_id = v_rfpl_trial;
    GET DIAGNOSTICS n_vou_updated = ROW_COUNT;

    DELETE FROM pramaana.ledgers WHERE id = v_rfpl_trial;
    RAISE NOTICE '✓ RFPL "Bank Account (RFPL)" removed  (% entries, % vouchers reassigned → Canara Bank)',
      n_ve_updated, n_vou_updated;
  ELSE
    RAISE NOTICE '⚠ RFPL "Bank Account (RFPL)" not found — already removed';
  END IF;

  -- ── RFPL: Cannara Bank  (misspelled trial entry) ─────────────────
  IF v_cannara IS NOT NULL THEN
    UPDATE pramaana.voucher_entries SET ledger_id = v_canara
      WHERE ledger_id = v_cannara;
    GET DIAGNOSTICS n_ve_updated = ROW_COUNT;

    UPDATE pramaana.vouchers SET bank_ledger_id = v_canara
      WHERE company_id = v_rfpl AND bank_ledger_id = v_cannara;
    GET DIAGNOSTICS n_vou_updated = ROW_COUNT;

    DELETE FROM pramaana.ledgers WHERE id = v_cannara;
    RAISE NOTICE '✓ RFPL "Cannara Bank" removed  (% entries, % vouchers reassigned → Canara Bank)',
      n_ve_updated, n_vou_updated;
  ELSE
    RAISE NOTICE '⚠ RFPL "Cannara Bank" not found — already removed';
  END IF;

  -- ── RHHF: Bank Account (RHHF) ────────────────────────────────────
  IF v_rhhf_trial IS NOT NULL THEN
    UPDATE pramaana.voucher_entries SET ledger_id = v_hdfc
      WHERE ledger_id = v_rhhf_trial;
    GET DIAGNOSTICS n_ve_updated = ROW_COUNT;

    UPDATE pramaana.vouchers SET bank_ledger_id = v_hdfc
      WHERE company_id = v_rhhf AND bank_ledger_id = v_rhhf_trial;
    GET DIAGNOSTICS n_vou_updated = ROW_COUNT;

    DELETE FROM pramaana.ledgers WHERE id = v_rhhf_trial;
    RAISE NOTICE '✓ RHHF "Bank Account (RHHF)" removed  (% entries, % vouchers reassigned → HDFC Current)',
      n_ve_updated, n_vou_updated;
  ELSE
    RAISE NOTICE '⚠ RHHF "Bank Account (RHHF)" not found — already removed';
  END IF;

  -- ── RHHF: SBI Current Account  (non-existent account) ───────────
  IF v_sbi IS NOT NULL THEN
    UPDATE pramaana.voucher_entries SET ledger_id = v_hdfc
      WHERE ledger_id = v_sbi;
    GET DIAGNOSTICS n_ve_updated = ROW_COUNT;

    UPDATE pramaana.vouchers SET bank_ledger_id = v_hdfc
      WHERE company_id = v_rhhf AND bank_ledger_id = v_sbi;
    GET DIAGNOSTICS n_vou_updated = ROW_COUNT;

    DELETE FROM pramaana.ledgers WHERE id = v_sbi;
    RAISE NOTICE '✓ RHHF "SBI Current Account" removed  (% entries, % vouchers reassigned → HDFC Current)',
      n_ve_updated, n_vou_updated;
  ELSE
    RAISE NOTICE '⚠ RHHF "SBI Current Account" not found — already removed';
  END IF;

END;
$cleanup$;

-- ── Verify: only real bank ledgers remain ────────────────────────────────────
SELECT c.code, l.name, l.bank_name, l.account_number, l.ifsc,
       l.is_bank_account, l.opening_balance
FROM pramaana.ledgers l
JOIN registry.companies c ON c.id = l.company_id
JOIN pramaana.ledger_groups lg ON lg.id = l.group_id
WHERE c.code IN ('RFPL', 'RHHF')
  AND lg.name = 'Bank Accounts'
ORDER BY c.code, l.name;
