-- ====================================================================
-- PRAMAANA SEED GENERATOR — RUN IN RELISH APPROVALS SUPABASE
-- ====================================================================
--
-- STEP 1 : Open Relish Approvals Supabase → SQL Editor
-- STEP 2 : Paste and run this ENTIRE file
-- STEP 3 : The result is ONE row with column  "seed_sql"
--           Click the cell → copy the full text
-- STEP 4 : Open Pramaana Supabase (mmkbknnzgpvsqgnynrbe) → SQL Editor
-- STEP 5 : Paste and run the copied text
--
-- This script is READ-ONLY on Relish Approvals.
-- Nothing is written or modified in Relish Approvals.
-- ====================================================================

WITH

-- ── Company code mapping ─────────────────────────────────────────────────────
cm(ra_id, pc) AS (VALUES
  ('relish-foods'::text, 'RFPL'::text),
  ('relish-hhc',         'RHHF')
),

-- ── Head-of-account → Pramaana system ledger group + nature ──────────────────
-- System group UUIDs from pramaana.ledger_groups WHERE company_id IS NULL
hm(head, grp_uuid, nat) AS (VALUES
  ('Bank Charges'::text,             '10000000-0000-0000-0000-000000000043'::text, 'EXPENSE'::text),
  ('Building Construction',          '10000000-0000-0000-0000-000000000011',       'ASSET'),
  ('Capital Expenditure',            '10000000-0000-0000-0000-000000000011',       'ASSET'),
  ('Loan Repayment',                 '10000000-0000-0000-0000-000000000027',       'LIABILITY'),
  ('Loans & Advances',               '10000000-0000-0000-0000-000000000017',       'ASSET'),
  ('Office Expenses',                '10000000-0000-0000-0000-000000000043',       'EXPENSE'),
  ('Professional Fees',              '10000000-0000-0000-0000-000000000043',       'EXPENSE'),
  ('Provision for staff',            '10000000-0000-0000-0000-000000000043',       'EXPENSE'),
  ('Rent',                           '10000000-0000-0000-0000-000000000043',       'EXPENSE'),
  ('Repairs & Maintenance',          '10000000-0000-0000-0000-000000000043',       'EXPENSE'),
  ('Salaries & Wages',               '10000000-0000-0000-0000-000000000043',       'EXPENSE'),
  ('Subscriptions',                  '10000000-0000-0000-0000-000000000043',       'EXPENSE'),
  ('Taxes & Duties',                 '10000000-0000-0000-0000-000000000025',       'LIABILITY'),
  ('Transportation & Freight',       '10000000-0000-0000-0000-000000000042',       'EXPENSE'),
  ('Travelling Expenses',            '10000000-0000-0000-0000-000000000043',       'EXPENSE')
),

-- ── All completed FY 2026-27 vouchers ────────────────────────────────────────
v AS (
  SELECT
    cm.pc,
    vv.serial_number                                             AS vnum,
    vv.created_at::date                                          AS vdate,
    vv.head_of_account                                           AS head,
    -- Ledger name = "Head - Sub-head"  (avoids conflicts where same sub-head
    -- appears under different heads, e.g. "Equipment Hire" under both
    -- Building Construction and Rent)
    CASE
      WHEN TRIM(COALESCE(vv.sub_head_of_account, '')) = ''
      THEN vv.head_of_account
      ELSE vv.head_of_account || ' - ' || TRIM(vv.sub_head_of_account)
    END                                                          AS exp_ledger,
    -- Normalise narration: collapse whitespace
    TRIM(REGEXP_REPLACE(COALESCE(vv.narration, ''), E'\\s+', ' ', 'g')) AS narr,
    vv.amount,
    vv.payment_mode,
    -- Payment credit ledger: "Bank Account (RFPL)" or "Cash (RFPL)"
    CASE WHEN vv.payment_mode = 'Cash'
         THEN 'Cash (' || cm.pc || ')'
         ELSE 'Bank Account (' || cm.pc || ')'
    END                                                          AS pay_ledger,
    vv.payment_mode = 'Cash'                                     AS is_cash,
    COALESCE(NULLIF(TRIM(vv.invoice_reference), ''), NULL)       AS inv_ref,
    vv.completed_at
  FROM public.vouchers vv
  JOIN cm ON cm.ra_id = vv.company_id
  WHERE vv.status IN ('approved', 'completed', 'paid')
    AND vv.created_at >= '2026-04-01'
),

-- ── Unique ledger groups per company ─────────────────────────────────────────
ug AS (
  SELECT DISTINCT
    pc, head,
    COALESCE(hm.grp_uuid, '10000000-0000-0000-0000-000000000043') AS grp_uuid,
    COALESCE(hm.nat, 'EXPENSE')                                    AS nat
  FROM v LEFT JOIN hm USING (head)
),

-- ── Unique expense/capital ledgers per company ────────────────────────────────
ul AS (SELECT DISTINCT pc, head, exp_ledger FROM v),

-- ── Unique payment (bank / cash) ledgers per company ─────────────────────────
upl AS (SELECT DISTINCT pc, pay_ledger, NOT is_cash AS is_bank FROM v),

-- ════════════════════════════════════════════════════════════════════════════
-- Generate the Pramaana seed SQL as text
-- ════════════════════════════════════════════════════════════════════════════
parts AS (

  /* ── HEADER ── */
  SELECT 10 AS blk, 0 AS seq,
    '-- ================================================================' || E'\n'
    || '-- PRAMAANA SEED: FY 2026-27 DATA (from Relish Approvals)' || E'\n'
    || '-- Generated: ' || NOW()::text || E'\n'
    || '-- Run in: Pramaana Supabase (mmkbknnzgpvsqgnynrbe) SQL Editor' || E'\n'
    || '-- ================================================================' || E'\n'
    || 'DO $seed$' || E'\n'
    || 'DECLARE' || E'\n'
    || '  v_rfpl UUID; v_rhhf UUID; v_prep UUID; v_vt UUID; v_vid UUID;' || E'\n'
    || 'BEGIN' || E'\n'
    || '  -- Resolve Pramaana company IDs by code' || E'\n'
    || '  SELECT id INTO v_rfpl FROM registry.companies WHERE code = ''RFPL'';' || E'\n'
    || '  SELECT id INTO v_rhhf FROM registry.companies WHERE code = ''RHHF'';' || E'\n'
    || '  -- Use oldest super-admin as the system prepared_by / completed_by user' || E'\n'
    || '  SELECT id INTO v_prep FROM registry.profiles WHERE is_super_admin ORDER BY created_at LIMIT 1;' || E'\n'
    || '  -- Resolve payment voucher type' || E'\n'
    || '  SELECT id INTO v_vt FROM pramaana.voucher_types WHERE nature = ''payment'' LIMIT 1;' || E'\n'
    || '  IF v_rfpl IS NULL THEN RAISE EXCEPTION ''RFPL not found in registry.companies''; END IF;' || E'\n'
    || '  IF v_rhhf IS NULL THEN RAISE EXCEPTION ''RHHF not found in registry.companies''; END IF;' || E'\n'
    || '  IF v_vt   IS NULL THEN RAISE EXCEPTION ''Payment voucher_type row missing in pramaana.voucher_types''; END IF;' || E'\n'
    AS sql_text

  UNION ALL

  /* ── SECTION 1 DIVIDER ── */
  SELECT 20, 0,
    E'\n  -- ═══════════════════════════════════════════════════════════\n'
    || '  -- 1. CUSTOM LEDGER GROUPS  (one per head-of-account, per company)' || E'\n'
    || '  --    Parent = the matching system group in pramaana.ledger_groups' || E'\n'
    || '  -- ═══════════════════════════════════════════════════════════'

  UNION ALL

  /* ── LEDGER GROUP INSERTS ── */
  SELECT 25, ROW_NUMBER() OVER (ORDER BY pc, head),
    E'\n'
    || '  INSERT INTO pramaana.ledger_groups (company_id, parent_id, code, name, nature)' || E'\n'
    || '  SELECT '
    || CASE WHEN pc = 'RFPL' THEN 'v_rfpl' ELSE 'v_rhhf' END
    || ', ' || quote_literal(grp_uuid) || '::uuid'
    || ', ' || quote_literal(
         UPPER(REGEXP_REPLACE(
           REGEXP_REPLACE(
             REGEXP_REPLACE(head, '[^a-zA-Z0-9 ]', '', 'g'),
           '\s+', '_', 'g'),
         '_+', '_', 'g'))
       )
    || ', ' || quote_literal(head)
    || ', ' || quote_literal(nat) || E'\n'
    || '  WHERE NOT EXISTS (' || E'\n'
    || '    SELECT 1 FROM pramaana.ledger_groups' || E'\n'
    || '    WHERE company_id = '
    || CASE WHEN pc = 'RFPL' THEN 'v_rfpl' ELSE 'v_rhhf' END
    || ' AND name = ' || quote_literal(head) || E'\n'
    || '  );'
  FROM ug

  UNION ALL

  /* ── SECTION 2 DIVIDER ── */
  SELECT 30, 0,
    E'\n  -- ═══════════════════════════════════════════════════════════\n'
    || '  -- 2. EXPENSE / CAPITAL / LIABILITY LEDGERS' || E'\n'
    || '  --    One ledger per unique (head, sub-head) combination' || E'\n'
    || '  --    Naming: "Head - Sub-head"  (or just "Head" when no sub-head)' || E'\n'
    || '  -- ═══════════════════════════════════════════════════════════'

  UNION ALL

  /* ── EXPENSE LEDGER INSERTS ── */
  SELECT 35, ROW_NUMBER() OVER (ORDER BY pc, head, exp_ledger),
    E'\n'
    || '  INSERT INTO pramaana.ledgers' || E'\n'
    || '    (company_id, group_id, name, tally_ledger_name,' || E'\n'
    || '     is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)' || E'\n'
    || '  SELECT '
    || CASE WHEN pc = 'RFPL' THEN 'v_rfpl' ELSE 'v_rhhf' END
    || ', lg.id'
    || ', ' || quote_literal(exp_ledger)
    || ', ' || quote_literal(exp_ledger)
    || ', FALSE, 0, ''Dr'', FALSE, TRUE' || E'\n'
    || '  FROM pramaana.ledger_groups lg' || E'\n'
    || '  WHERE lg.company_id = '
    || CASE WHEN pc = 'RFPL' THEN 'v_rfpl' ELSE 'v_rhhf' END
    || ' AND lg.name = ' || quote_literal(head) || E'\n'
    || '  AND NOT EXISTS (' || E'\n'
    || '    SELECT 1 FROM pramaana.ledgers' || E'\n'
    || '    WHERE company_id = '
    || CASE WHEN pc = 'RFPL' THEN 'v_rfpl' ELSE 'v_rhhf' END
    || ' AND name = ' || quote_literal(exp_ledger) || E'\n'
    || '  );'
  FROM ul

  UNION ALL

  /* ── SECTION 3 DIVIDER ── */
  SELECT 40, 0,
    E'\n  -- ═══════════════════════════════════════════════════════════\n'
    || '  -- 3. BANK / CASH PAYMENT LEDGERS' || E'\n'
    || '  --    "Bank Account (RFPL)" / "Cash (RFPL)" etc.' || E'\n'
    || '  -- ═══════════════════════════════════════════════════════════'

  UNION ALL

  /* ── BANK / CASH LEDGER INSERTS ── */
  SELECT 45, ROW_NUMBER() OVER (ORDER BY pc, pay_ledger),
    E'\n'
    || '  INSERT INTO pramaana.ledgers' || E'\n'
    || '    (company_id, group_id, name, tally_ledger_name,' || E'\n'
    || '     is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)' || E'\n'
    || '  SELECT '
    || CASE WHEN pc = 'RFPL' THEN 'v_rfpl' ELSE 'v_rhhf' END
    || ', lg.id'
    || ', ' || quote_literal(pay_ledger)
    || ', ' || quote_literal(pay_ledger)
    || ', ' || CASE WHEN is_bank THEN 'TRUE' ELSE 'FALSE' END
    || ', 0, ''Dr'', FALSE, TRUE' || E'\n'
    || '  FROM pramaana.ledger_groups lg' || E'\n'
    || '  WHERE lg.company_id IS NULL AND lg.name = '
    || CASE WHEN is_bank THEN '''Bank Accounts''' ELSE '''Cash in Hand''' END || E'\n'
    || '  AND NOT EXISTS (' || E'\n'
    || '    SELECT 1 FROM pramaana.ledgers' || E'\n'
    || '    WHERE company_id = '
    || CASE WHEN pc = 'RFPL' THEN 'v_rfpl' ELSE 'v_rhhf' END
    || ' AND name = ' || quote_literal(pay_ledger) || E'\n'
    || '  );'
  FROM upl

  UNION ALL

  /* ── SECTION 4 DIVIDER ── */
  SELECT 50, 0,
    E'\n  -- ═══════════════════════════════════════════════════════════\n'
    || '  -- 4. PAYMENT VOUCHERS  +  DOUBLE-ENTRY LINES' || E'\n'
    || '  --    Each voucher wrapped in BEGIN/EXCEPTION to skip duplicates' || E'\n'
    || '  --    Dr: expense/capital ledger   Cr: bank or cash ledger' || E'\n'
    || '  -- ═══════════════════════════════════════════════════════════'

  UNION ALL

  /* ── PAYMENT VOUCHER INSERTS ── */
  SELECT 55, ROW_NUMBER() OVER (ORDER BY pc, vdate, vnum),
    E'\n'
    || '  -- ' || pc || ' | ' || vnum || ' | ' || vdate::text || E'\n'
    || '  BEGIN' || E'\n'
    || '    INSERT INTO pramaana.vouchers' || E'\n'
    || '      (company_id, voucher_type_id, voucher_number, voucher_date,' || E'\n'
    || '       narration, ref_document_number, amount, payment_mode,' || E'\n'
    || '       status, created_by, completed_at, completed_by)' || E'\n'
    || '    VALUES (' || E'\n'
    || '      ' || CASE WHEN pc = 'RFPL' THEN 'v_rfpl' ELSE 'v_rhhf' END || ',' || E'\n'
    || '      v_vt,' || E'\n'
    || '      ' || quote_literal(vnum) || ',' || E'\n'
    || '      ' || quote_literal(vdate::text) || '::date,' || E'\n'
    || '      ' || CASE WHEN narr = '' THEN quote_literal(exp_ledger) ELSE quote_literal(narr) END || ',' || E'\n'
    || '      ' || COALESCE(quote_literal(inv_ref), 'NULL') || ',' || E'\n'
    || '      ' || amount::text || ',' || E'\n'
    || '      ' || quote_literal(payment_mode) || ',' || E'\n'
    || '      ''completed'',' || E'\n'
    || '      v_prep,' || E'\n'
    || '      ' || COALESCE(quote_literal(completed_at::text) || '::timestamptz', 'NULL') || ',' || E'\n'
    || '      v_prep' || E'\n'
    || '    ) RETURNING id INTO v_vid;' || E'\n'
    || '    INSERT INTO pramaana.voucher_entries' || E'\n'
    || '      (voucher_id, ledger_id, entry_type, amount, narration, sort_order)' || E'\n'
    || '    VALUES' || E'\n'
    -- Dr line: expense/capital ledger
    || '      (v_vid,' || E'\n'
    || '       (SELECT id FROM pramaana.ledgers' || E'\n'
    || '        WHERE company_id = '
    || CASE WHEN pc = 'RFPL' THEN 'v_rfpl' ELSE 'v_rhhf' END
    || ' AND name = ' || quote_literal(exp_ledger) || '),' || E'\n'
    || '       ''Dr'', ' || amount::text || ', '
    || CASE WHEN narr = '' THEN quote_literal(exp_ledger) ELSE quote_literal(narr) END
    || ', 1),' || E'\n'
    -- Cr line: bank or cash ledger
    || '      (v_vid,' || E'\n'
    || '       (SELECT id FROM pramaana.ledgers' || E'\n'
    || '        WHERE company_id = '
    || CASE WHEN pc = 'RFPL' THEN 'v_rfpl' ELSE 'v_rhhf' END
    || ' AND name = ' || quote_literal(pay_ledger) || '),' || E'\n'
    || '       ''Cr'', ' || amount::text || ', '
    || CASE WHEN narr = '' THEN quote_literal(pay_ledger) ELSE quote_literal(narr) END
    || ', 2);' || E'\n'
    || '  EXCEPTION WHEN unique_violation THEN' || E'\n'
    || '    NULL; -- voucher already exists, skip' || E'\n'
    || '  END;'
  FROM v

  UNION ALL

  /* ── FOOTER ── */
  SELECT 90, 0,
    E'\n\n  RAISE NOTICE ''✓ Pramaana seed complete — FY 2026-27 data loaded.'';'
    || E'\nEND;'
    || E'\n$seed$;'
)

-- ── Concatenate all parts into a single SQL string ───────────────────────────
SELECT string_agg(sql_text, '' ORDER BY blk, seq) AS seed_sql
FROM parts;
