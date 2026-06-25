-- ====================================================================
-- PRAMAANA SEED: RFPL Lease Rent Income — FY 2026-27
-- Tenant: Peninsular Fisheries Pvt Ltd
-- ====================================================================
--
-- MONTHLY STRUCTURE (Apr–Jun 2026):
--   Gross invoice   : ₹2,10,000 base + ₹37,800 GST (18%) = ₹2,47,800
--   Less TDS 10%    : ₹21,000  (tenant deducts, pays govt, gives cert)
--   Less Deposit rec: ₹50,000  (₹50L deposit returned ₹50K/month)
--   Net cash to RFPL: ₹1,76,800
--
-- OPENING BALANCE (April 1, 2026):
--   Peninsular Fisheries Pvt Ltd   ₹2,14,600 Dr  (March 2026 FY25-26 arrear)
--   Security Deposit Rcvd (PF)   ₹50,00,000 Cr  (deposit held by RFPL)
--
-- RECONCILIATION CHECK:
--   Opening ₹2,14,600 → cleared by Apr 8 (₹1,39,000) + Apr 25 (₹75,600) = ₹0 ✓
--   Apr accrual → cleared by May 4 (₹1,39,000) + May 25 (₹37,800) = ₹0 ✓
--   May accrual → cleared by Jun 4 (₹1,76,800) = ₹0 ✓
--
-- Run AFTER 042_setup_bank_account_ledgers.sql
-- Run in: Pramaana Supabase (mmkbknnzgpvsqgnynrbe) → SQL Editor
-- ====================================================================

DO $rent$
DECLARE
  v_rfpl         UUID;
  v_prep         UUID;
  v_vt_receipt   UUID;
  v_vt_journal   UUID;

  -- Ledger IDs
  v_canara       UUID;   -- Canara Bank (RFPL) — from 042
  v_pf           UUID;   -- Peninsular Fisheries Pvt Ltd
  v_rent         UUID;   -- Lease Rent Income
  v_gst_out      UUID;   -- Output GST Payable (18%)
  v_tds_rcv      UUID;   -- TDS Receivable - Sec 194I
  v_sec_dep      UUID;   -- Security Deposit Received (PF)

  -- Ledger group IDs (resolved dynamically)
  v_debtors_grp  UUID;   -- Sundry Debtors  (ASSET)
  v_income_grp   UUID;   -- Indirect Income (INCOME)
  v_tax_grp      UUID;   -- Duties & Taxes  (LIABILITY) — known
  v_loans_grp    UUID;   -- Loans & Advances Given (ASSET) — for TDS Rcv
  v_curr_liab    UUID;   -- Current Liabilities (LIABILITY) — for Sec Dep

  v_vid          UUID;

  -- Rate 1: Apr–Jun 2026
  base_r1    NUMERIC := 210000;
  gst_r1     NUMERIC := 37800;
  total_r1   NUMERIC := 247800;   -- gross invoice
  tds_r1     NUMERIC := 21000;    -- 10% of base
  dep_rec    NUMERIC := 50000;    -- deposit recovery (same both periods)
  net_r1     NUMERIC := 176800;   -- cash received = 247800 - 21000 - 50000

BEGIN
  -- ── Core IDs ─────────────────────────────────────────────────────
  SELECT id INTO v_rfpl FROM registry.companies WHERE code = 'RFPL';
  SELECT id INTO v_prep FROM registry.profiles
    WHERE is_super_admin ORDER BY created_at LIMIT 1;
  SELECT id INTO v_vt_receipt FROM pramaana.voucher_types WHERE nature = 'receipt' LIMIT 1;
  SELECT id INTO v_vt_journal FROM pramaana.voucher_types WHERE nature = 'journal' LIMIT 1;

  IF v_rfpl       IS NULL THEN RAISE EXCEPTION 'RFPL not found'; END IF;
  IF v_vt_receipt IS NULL THEN RAISE EXCEPTION 'Receipt voucher type not found'; END IF;
  IF v_vt_journal IS NULL THEN RAISE EXCEPTION 'Journal voucher type not found — check pramaana.voucher_types'; END IF;

  -- Canara Bank (created by 042)
  SELECT id INTO v_canara FROM pramaana.ledgers
    WHERE company_id = v_rfpl AND name = 'Canara Bank';
  IF v_canara IS NULL THEN
    RAISE EXCEPTION 'Canara Bank ledger not found — run 042_setup_bank_account_ledgers.sql first';
  END IF;

  -- ── Resolve system ledger groups ─────────────────────────────────
  -- Sundry Debtors
  SELECT id INTO v_debtors_grp FROM pramaana.ledger_groups
    WHERE company_id IS NULL AND name ILIKE '%sundry debtor%' LIMIT 1;
  IF v_debtors_grp IS NULL THEN
    SELECT id INTO v_debtors_grp FROM pramaana.ledger_groups
      WHERE company_id IS NULL AND nature = 'ASSET'
      AND name ILIKE '%debtor%' LIMIT 1;
  END IF;

  -- Indirect Income
  SELECT id INTO v_income_grp FROM pramaana.ledger_groups
    WHERE company_id IS NULL AND nature = 'INCOME'
    AND name ILIKE '%indirect%' LIMIT 1;
  IF v_income_grp IS NULL THEN
    SELECT id INTO v_income_grp FROM pramaana.ledger_groups
      WHERE company_id IS NULL AND nature = 'INCOME' LIMIT 1;
  END IF;

  -- Duties & Taxes (known UUID from system seed)
  v_tax_grp := '10000000-0000-0000-0000-000000000025'::uuid;

  -- Loans & Advances Given (for TDS Receivable asset)
  v_loans_grp := '10000000-0000-0000-0000-000000000017'::uuid;

  -- Current Liabilities (for Security Deposit)
  SELECT id INTO v_curr_liab FROM pramaana.ledger_groups
    WHERE company_id IS NULL AND nature = 'LIABILITY'
    AND name ILIKE '%current liabil%' LIMIT 1;
  IF v_curr_liab IS NULL THEN
    SELECT id INTO v_curr_liab FROM pramaana.ledger_groups
      WHERE company_id IS NULL AND nature = 'LIABILITY'
      AND name ILIKE '%deposit%' LIMIT 1;
  END IF;
  IF v_curr_liab IS NULL THEN
    -- Final fallback: any non-duties LIABILITY system group
    SELECT id INTO v_curr_liab FROM pramaana.ledger_groups
      WHERE company_id IS NULL AND nature = 'LIABILITY'
      AND id <> v_tax_grp LIMIT 1;
  END IF;

  IF v_debtors_grp IS NULL THEN RAISE EXCEPTION 'Sundry Debtors group not found'; END IF;
  IF v_income_grp  IS NULL THEN RAISE EXCEPTION 'Income group not found'; END IF;
  IF v_curr_liab   IS NULL THEN RAISE EXCEPTION 'Current Liabilities group not found'; END IF;

  -- ════════════════════════════════════════════════════════════════
  -- 1. CREATE LEDGERS
  -- ════════════════════════════════════════════════════════════════

  -- Peninsular Fisheries Pvt Ltd  (Sundry Debtors)
  -- Opening balance = March 2026 rent arrear (FY 2025-26) = ₹2,14,600 Dr
  INSERT INTO pramaana.ledgers
    (company_id, group_id, name, tally_ledger_name,
     is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
  SELECT v_rfpl, v_debtors_grp,
    'Peninsular Fisheries Pvt Ltd', 'Peninsular Fisheries Pvt Ltd',
    FALSE, 214600, 'Dr', FALSE, TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM pramaana.ledgers
    WHERE company_id = v_rfpl AND name = 'Peninsular Fisheries Pvt Ltd'
  );
  SELECT id INTO v_pf FROM pramaana.ledgers
    WHERE company_id = v_rfpl AND name = 'Peninsular Fisheries Pvt Ltd';

  -- Lease Rent Income  (Indirect Income)
  INSERT INTO pramaana.ledgers
    (company_id, group_id, name, tally_ledger_name,
     is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
  SELECT v_rfpl, v_income_grp,
    'Lease Rent Income', 'Lease Rent Income',
    FALSE, 0, 'Cr', FALSE, TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM pramaana.ledgers WHERE company_id = v_rfpl AND name = 'Lease Rent Income'
  );
  SELECT id INTO v_rent FROM pramaana.ledgers
    WHERE company_id = v_rfpl AND name = 'Lease Rent Income';

  -- Output GST Payable (18%)  (Duties & Taxes)
  INSERT INTO pramaana.ledgers
    (company_id, group_id, name, tally_ledger_name,
     is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
  SELECT v_rfpl, v_tax_grp,
    'Output GST Payable (18%)', 'Output GST Payable (18%)',
    FALSE, 0, 'Cr', FALSE, TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM pramaana.ledgers WHERE company_id = v_rfpl AND name = 'Output GST Payable (18%)'
  );
  SELECT id INTO v_gst_out FROM pramaana.ledgers
    WHERE company_id = v_rfpl AND name = 'Output GST Payable (18%)';

  -- TDS Receivable - Sec 194I  (Loans & Advances Given)
  INSERT INTO pramaana.ledgers
    (company_id, group_id, name, tally_ledger_name,
     is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
  SELECT v_rfpl, v_loans_grp,
    'TDS Receivable - Sec 194I', 'TDS Receivable - Sec 194I',
    FALSE, 0, 'Dr', FALSE, TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM pramaana.ledgers WHERE company_id = v_rfpl AND name = 'TDS Receivable - Sec 194I'
  );
  SELECT id INTO v_tds_rcv FROM pramaana.ledgers
    WHERE company_id = v_rfpl AND name = 'TDS Receivable - Sec 194I';

  -- Security Deposit Received (Peninsular Fisheries)  (Current Liabilities)
  -- Received: 18-Mar-2024 = ₹50,00,000
  -- Deductions: Mar-2025 to Mar-2026 = 13 months × ₹50,000 = ₹6,50,000
  -- Opening balance as at 01-Apr-2026 = ₹50,00,000 - ₹6,50,000 = ₹43,50,000 Cr
  INSERT INTO pramaana.ledgers
    (company_id, group_id, name, tally_ledger_name,
     is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
  SELECT v_rfpl, v_curr_liab,
    'Security Deposit Rcvd - Peninsular Fisheries',
    'Security Deposit Rcvd - Peninsular Fisheries',
    FALSE, 4350000, 'Cr', FALSE, TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM pramaana.ledgers WHERE company_id = v_rfpl
      AND name = 'Security Deposit Rcvd - Peninsular Fisheries'
  );
  SELECT id INTO v_sec_dep FROM pramaana.ledgers
    WHERE company_id = v_rfpl
    AND name = 'Security Deposit Rcvd - Peninsular Fisheries';

  -- ════════════════════════════════════════════════════════════════
  -- 2. OPENING BALANCE RECOVERY  (April receipts = March 2026 FY25-26)
  --    These clear the ₹2,14,600 opening balance on PF's account.
  -- ════════════════════════════════════════════════════════════════

  -- Apr 8: ₹1,39,000  (March base rent less TDS less deposit recovery)
  BEGIN
    INSERT INTO pramaana.vouchers
      (company_id, voucher_type_id, voucher_number, voucher_date,
       narration, amount, payment_mode, status, created_by, completed_at, completed_by)
    VALUES (v_rfpl, v_vt_receipt, 'RCPT/RFPL/2627/R001', '2026-04-08',
      'Rent recd from Peninsular Fisheries — Mar-2026 base (part)',
      139000, 'Account Transfer', 'completed', v_prep, now(), v_prep)
    RETURNING id INTO v_vid;
    INSERT INTO pramaana.voucher_entries
      (voucher_id, ledger_id, entry_type, amount, narration, sort_order) VALUES
      (v_vid, v_canara, 'Dr', 139000, 'Peninsular Fisheries Mar-2026 part-1', 1),
      (v_vid, v_pf,     'Cr', 139000, 'Mar-2026 rent partial receipt',        2);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Apr 25: ₹75,600  (GST for 2 months — Feb + Mar 2026)
  BEGIN
    INSERT INTO pramaana.vouchers
      (company_id, voucher_type_id, voucher_number, voucher_date,
       narration, amount, payment_mode, status, created_by, completed_at, completed_by)
    VALUES (v_rfpl, v_vt_receipt, 'RCPT/RFPL/2627/R002', '2026-04-25',
      'Rent recd from Peninsular Fisheries — GST arrear (Feb+Mar 2026)',
      75600, 'Account Transfer', 'completed', v_prep, now(), v_prep)
    RETURNING id INTO v_vid;
    INSERT INTO pramaana.voucher_entries
      (voucher_id, ledger_id, entry_type, amount, narration, sort_order) VALUES
      (v_vid, v_canara, 'Dr', 75600, 'Peninsular Fisheries GST arrear', 1),
      (v_vid, v_pf,     'Cr', 75600, 'GST arrear Feb+Mar 2026',         2);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- ════════════════════════════════════════════════════════════════
  -- 3. APRIL 2026 RENT  (FY 2026-27 Month 1)
  -- ════════════════════════════════════════════════════════════════

  -- 3a. Rent accrual journal  (April 30)
  BEGIN
    INSERT INTO pramaana.vouchers
      (company_id, voucher_type_id, voucher_number, voucher_date,
       narration, amount, status, created_by, completed_at, completed_by)
    VALUES (v_rfpl, v_vt_journal, 'JNL/RFPL/2627/J001', '2026-04-30',
      'Lease rent accrual — April 2026 (PF)',
      total_r1, 'completed', v_prep, now(), v_prep)
    RETURNING id INTO v_vid;
    INSERT INTO pramaana.voucher_entries
      (voucher_id, ledger_id, entry_type, amount, narration, sort_order) VALUES
      (v_vid, v_pf,      'Dr', total_r1, 'Apr-2026 rent invoice',    1),
      (v_vid, v_rent,    'Cr', base_r1,  'Lease rent Apr-2026',       2),
      (v_vid, v_gst_out, 'Cr', gst_r1,   'Output GST 18% Apr-2026',  3);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 3b. TDS journal  (April 30)
  BEGIN
    INSERT INTO pramaana.vouchers
      (company_id, voucher_type_id, voucher_number, voucher_date,
       narration, amount, status, created_by, completed_at, completed_by)
    VALUES (v_rfpl, v_vt_journal, 'JNL/RFPL/2627/J002', '2026-04-30',
      'TDS deducted by Peninsular Fisheries — April 2026 (Sec 194I)',
      tds_r1, 'completed', v_prep, now(), v_prep)
    RETURNING id INTO v_vid;
    INSERT INTO pramaana.voucher_entries
      (voucher_id, ledger_id, entry_type, amount, narration, sort_order) VALUES
      (v_vid, v_tds_rcv, 'Dr', tds_r1, 'TDS 10% Apr-2026 Sec194I', 1),
      (v_vid, v_pf,      'Cr', tds_r1, 'TDS deducted Apr-2026',     2);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 3c. Deposit recovery journal  (April 30)
  BEGIN
    INSERT INTO pramaana.vouchers
      (company_id, voucher_type_id, voucher_number, voucher_date,
       narration, amount, status, created_by, completed_at, completed_by)
    VALUES (v_rfpl, v_vt_journal, 'JNL/RFPL/2627/J003', '2026-04-30',
      'Deposit recovery deduction — April 2026',
      dep_rec, 'completed', v_prep, now(), v_prep)
    RETURNING id INTO v_vid;
    INSERT INTO pramaana.voucher_entries
      (voucher_id, ledger_id, entry_type, amount, narration, sort_order) VALUES
      (v_vid, v_sec_dep, 'Dr', dep_rec, 'Deposit returned Apr-2026', 1),
      (v_vid, v_pf,      'Cr', dep_rec, 'Deposit recovery Apr-2026', 2);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 3d. Cash receipts for April rent  (received in May)
  -- May 4: ₹1,39,000  (base portion)
  BEGIN
    INSERT INTO pramaana.vouchers
      (company_id, voucher_type_id, voucher_number, voucher_date,
       narration, amount, payment_mode, status, created_by, completed_at, completed_by)
    VALUES (v_rfpl, v_vt_receipt, 'RCPT/RFPL/2627/R003', '2026-05-04',
      'Rent recd from Peninsular Fisheries — Apr-2026 base (part)',
      139000, 'Account Transfer', 'completed', v_prep, now(), v_prep)
    RETURNING id INTO v_vid;
    INSERT INTO pramaana.voucher_entries
      (voucher_id, ledger_id, entry_type, amount, narration, sort_order) VALUES
      (v_vid, v_canara, 'Dr', 139000, 'PF Apr-2026 rent part-1', 1),
      (v_vid, v_pf,     'Cr', 139000, 'Apr-2026 rent receipt',   2);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- May 25: ₹37,800  (GST portion)
  BEGIN
    INSERT INTO pramaana.vouchers
      (company_id, voucher_type_id, voucher_number, voucher_date,
       narration, amount, payment_mode, status, created_by, completed_at, completed_by)
    VALUES (v_rfpl, v_vt_receipt, 'RCPT/RFPL/2627/R004', '2026-05-25',
      'Rent recd from Peninsular Fisheries — Apr-2026 GST',
      37800, 'Account Transfer', 'completed', v_prep, now(), v_prep)
    RETURNING id INTO v_vid;
    INSERT INTO pramaana.voucher_entries
      (voucher_id, ledger_id, entry_type, amount, narration, sort_order) VALUES
      (v_vid, v_canara, 'Dr', 37800, 'PF Apr-2026 GST receipt', 1),
      (v_vid, v_pf,     'Cr', 37800, 'Apr-2026 GST receipt',    2);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- ════════════════════════════════════════════════════════════════
  -- 4. MAY 2026 RENT  (FY 2026-27 Month 2)
  -- ════════════════════════════════════════════════════════════════

  -- 4a. Rent accrual journal  (May 31)
  BEGIN
    INSERT INTO pramaana.vouchers
      (company_id, voucher_type_id, voucher_number, voucher_date,
       narration, amount, status, created_by, completed_at, completed_by)
    VALUES (v_rfpl, v_vt_journal, 'JNL/RFPL/2627/J004', '2026-05-31',
      'Lease rent accrual — May 2026 (PF)',
      total_r1, 'completed', v_prep, now(), v_prep)
    RETURNING id INTO v_vid;
    INSERT INTO pramaana.voucher_entries
      (voucher_id, ledger_id, entry_type, amount, narration, sort_order) VALUES
      (v_vid, v_pf,      'Dr', total_r1, 'May-2026 rent invoice',   1),
      (v_vid, v_rent,    'Cr', base_r1,  'Lease rent May-2026',      2),
      (v_vid, v_gst_out, 'Cr', gst_r1,   'Output GST 18% May-2026', 3);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 4b. TDS journal  (May 31)
  BEGIN
    INSERT INTO pramaana.vouchers
      (company_id, voucher_type_id, voucher_number, voucher_date,
       narration, amount, status, created_by, completed_at, completed_by)
    VALUES (v_rfpl, v_vt_journal, 'JNL/RFPL/2627/J005', '2026-05-31',
      'TDS deducted by Peninsular Fisheries — May 2026 (Sec 194I)',
      tds_r1, 'completed', v_prep, now(), v_prep)
    RETURNING id INTO v_vid;
    INSERT INTO pramaana.voucher_entries
      (voucher_id, ledger_id, entry_type, amount, narration, sort_order) VALUES
      (v_vid, v_tds_rcv, 'Dr', tds_r1, 'TDS 10% May-2026 Sec194I', 1),
      (v_vid, v_pf,      'Cr', tds_r1, 'TDS deducted May-2026',     2);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 4c. Deposit recovery journal  (May 31)
  BEGIN
    INSERT INTO pramaana.vouchers
      (company_id, voucher_type_id, voucher_number, voucher_date,
       narration, amount, status, created_by, completed_at, completed_by)
    VALUES (v_rfpl, v_vt_journal, 'JNL/RFPL/2627/J006', '2026-05-31',
      'Deposit recovery deduction — May 2026',
      dep_rec, 'completed', v_prep, now(), v_prep)
    RETURNING id INTO v_vid;
    INSERT INTO pramaana.voucher_entries
      (voucher_id, ledger_id, entry_type, amount, narration, sort_order) VALUES
      (v_vid, v_sec_dep, 'Dr', dep_rec, 'Deposit returned May-2026', 1),
      (v_vid, v_pf,      'Cr', dep_rec, 'Deposit recovery May-2026', 2);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 4d. Cash receipt for May rent  (received June 4 — full in one go)
  BEGIN
    INSERT INTO pramaana.vouchers
      (company_id, voucher_type_id, voucher_number, voucher_date,
       narration, amount, payment_mode, status, created_by, completed_at, completed_by)
    VALUES (v_rfpl, v_vt_receipt, 'RCPT/RFPL/2627/R005', '2026-06-04',
      'Rent recd from Peninsular Fisheries — May-2026 (full)',
      net_r1, 'Account Transfer', 'completed', v_prep, now(), v_prep)
    RETURNING id INTO v_vid;
    INSERT INTO pramaana.voucher_entries
      (voucher_id, ledger_id, entry_type, amount, narration, sort_order) VALUES
      (v_vid, v_canara, 'Dr', net_r1, 'PF May-2026 rent full', 1),
      (v_vid, v_pf,     'Cr', net_r1, 'May-2026 rent receipt', 2);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  RAISE NOTICE '✓ RFPL Lease Rent entries loaded';
  RAISE NOTICE '  5 ledgers created with opening balances';
  RAISE NOTICE '  11 vouchers inserted (2 receipts OB + 3 journals Apr + 2 receipts Apr + 3 journals May + 1 receipt May)';

END;
$rent$;

-- ── Verify: Peninsular Fisheries running balance ──────────────────────────────
SELECT
  v.voucher_date,
  v.voucher_number,
  v.narration,
  CASE WHEN ve.entry_type = 'Dr' THEN ve.amount ELSE 0 END AS dr,
  CASE WHEN ve.entry_type = 'Cr' THEN ve.amount ELSE 0 END AS cr
FROM pramaana.voucher_entries ve
JOIN pramaana.vouchers v ON v.id = ve.voucher_id
JOIN pramaana.ledgers l ON l.id = ve.ledger_id
JOIN registry.companies c ON c.id = v.company_id
WHERE c.code = 'RFPL'
  AND l.name = 'Peninsular Fisheries Pvt Ltd'
ORDER BY v.voucher_date, v.voucher_number;

-- ── Verify: income and balance ledgers ───────────────────────────────────────
SELECT
  l.name,
  l.opening_balance,
  l.opening_dr_cr,
  SUM(CASE WHEN ve.entry_type = 'Dr' THEN ve.amount ELSE -ve.amount END) AS period_net_dr
FROM pramaana.ledgers l
LEFT JOIN pramaana.voucher_entries ve ON ve.ledger_id = l.id
JOIN registry.companies c ON c.id = l.company_id
WHERE c.code = 'RFPL'
  AND l.name IN (
    'Lease Rent Income',
    'Output GST Payable (18%)',
    'TDS Receivable - Sec 194I',
    'Security Deposit Rcvd - Peninsular Fisheries',
    'Peninsular Fisheries Pvt Ltd'
  )
GROUP BY l.id, l.name, l.opening_balance, l.opening_dr_cr
ORDER BY l.name;

-- ════════════════════════════════════════════════════════════════════
-- ONGOING MONTHLY ENTRY TEMPLATE (from June 2026 onwards)
-- ════════════════════════════════════════════════════════════════════
--
-- Jun 2026 (same rate):
--   base ₹2,10,000 | GST ₹37,800 | TDS ₹21,000 | dep ₹50,000 | cash ₹1,76,800
--
-- Jul 2026 onwards (+5% increase):
--   base ₹2,20,500 | GST ₹39,690 | TDS ₹22,050 | dep ₹50,000 | cash ₹1,88,140
--
-- For UI entry each month (4 vouchers):
--   1. Journal (end of month): Dr PF [total] | Cr Lease Rent [base] | Cr GST [gst]
--   2. Journal (end of month): Dr TDS Rcv [tds] | Cr PF [tds]
--   3. Journal (end of month): Dr Sec Dep Rcvd [50,000] | Cr PF [50,000]
--   4. Receipt (when cash arrives): Dr Canara Bank [net] | Cr PF [net]
-- ════════════════════════════════════════════════════════════════════

