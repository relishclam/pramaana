-- ====================================================================
-- PRAMAANA SETUP: Correct Bank Account Ledgers
-- ====================================================================
--
-- Run AFTER 041_CLEANUP_delete_trial_data.sql Section B is complete.
--
-- Creates the 4 real bank account ledgers for RFPL and RHHF.
-- Opening balances are set to 0 here — update them separately once
-- you have the actual bank balances as at 01-Apr-2026.
--
-- Run in: Pramaana Supabase (mmkbknnzgpvsqgnynrbe) → SQL Editor
-- ====================================================================

DO $banks$
DECLARE
  v_rfpl     UUID;
  v_rhhf     UUID;
  v_bank_grp UUID;
BEGIN
  SELECT id INTO v_rfpl FROM registry.companies WHERE code = 'RFPL';
  SELECT id INTO v_rhhf FROM registry.companies WHERE code = 'RHHF';

  IF v_rfpl IS NULL THEN RAISE EXCEPTION 'RFPL not found in registry.companies'; END IF;
  IF v_rhhf IS NULL THEN RAISE EXCEPTION 'RHHF not found in registry.companies'; END IF;

  -- System Bank Accounts ledger group (company_id IS NULL)
  SELECT id INTO v_bank_grp
  FROM pramaana.ledger_groups
  WHERE company_id IS NULL AND name = 'Bank Accounts';

  IF v_bank_grp IS NULL THEN RAISE EXCEPTION 'System ledger group "Bank Accounts" not found'; END IF;

  -- ── RFPL ──────────────────────────────────────────────────────────

  -- 1. Canara Bank  (Acct: 0701201001375 · IFSC: CNRB0000701 · Customer: 124696389)
  INSERT INTO pramaana.ledgers
    (company_id, group_id, name, tally_ledger_name,
     bank_name, account_number, ifsc,
     is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
  SELECT v_rfpl, v_bank_grp,
    'Canara Bank', 'Canara Bank',
    'Canara Bank Ltd', '0701201001375', 'CNRB0000701',
    TRUE, 0, 'Dr', FALSE, TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM pramaana.ledgers
    WHERE company_id = v_rfpl AND name = 'Canara Bank'
  );

  -- 2. Federal Bank  (Acct: 10150200014513 · IFSC: FDRL0001015 · Customer: 22680333)
  INSERT INTO pramaana.ledgers
    (company_id, group_id, name, tally_ledger_name,
     bank_name, account_number, ifsc,
     is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
  SELECT v_rfpl, v_bank_grp,
    'Federal Bank', 'Federal Bank',
    'Federal Bank Ltd', '10150200014513', 'FDRL0001015',
    TRUE, 0, 'Dr', FALSE, TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM pramaana.ledgers
    WHERE company_id = v_rfpl AND name = 'Federal Bank'
  );

  -- ── RHHF ──────────────────────────────────────────────────────────

  -- 3. HDFC Bank Ltd - Current Account  (Acct: 99999446012324 · IFSC: HDFC0000682 · UPI: 9446012324@hdfc)
  INSERT INTO pramaana.ledgers
    (company_id, group_id, name, tally_ledger_name,
     bank_name, account_number, ifsc,
     is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
  SELECT v_rhhf, v_bank_grp,
    'HDFC Bank Ltd - Current Account', 'HDFC Bank Ltd - Current Account',
    'HDFC Bank Ltd', '99999446012324', 'HDFC0000682',
    TRUE, 0, 'Dr', FALSE, TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM pramaana.ledgers
    WHERE company_id = v_rhhf AND name = 'HDFC Bank Ltd - Current Account'
  );

  -- 4. HDFC Bank Ltd - Current Account (No-Lien)  (Acct: 50200115901702 · IFSC: HDFC0000682 · UPI: 9446012324.1@hdfc)
  INSERT INTO pramaana.ledgers
    (company_id, group_id, name, tally_ledger_name,
     bank_name, account_number, ifsc,
     is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
  SELECT v_rhhf, v_bank_grp,
    'HDFC Bank Ltd - Current Account (No-Lien)', 'HDFC Bank Ltd - Current Account (No-Lien)',
    'HDFC Bank Ltd', '50200115901702', 'HDFC0000682',
    TRUE, 0, 'Dr', FALSE, TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM pramaana.ledgers
    WHERE company_id = v_rhhf AND name = 'HDFC Bank Ltd - Current Account (No-Lien)'
  );

  RAISE NOTICE '✓ Bank account ledgers created for RFPL and RHHF';
END;
$banks$;

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT c.code, l.name, l.bank_name, l.account_number, l.ifsc, l.is_bank_account, l.opening_balance
FROM pramaana.ledgers l
JOIN registry.companies c ON c.id = l.company_id
JOIN pramaana.ledger_groups lg ON lg.id = l.group_id
WHERE c.code IN ('RFPL', 'RHHF')
  AND lg.name = 'Bank Accounts'
ORDER BY c.code, l.name;

-- ── TODO: Update opening balances ─────────────────────────────────────────────
-- Once you have bank balances as at 01-Apr-2026, run:
--
-- UPDATE pramaana.ledgers SET opening_balance = <amount>, opening_dr_cr = 'Dr'
-- WHERE company_id = (SELECT id FROM registry.companies WHERE code = 'RFPL')
--   AND name = 'Canara Bank';
--
-- (Repeat for each bank ledger)
