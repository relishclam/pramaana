-- ── Seed test ledgers for RHHF ──────────────────────────────────────────────
-- Purpose : Minimal ledger set for end-to-end voucher flow testing
-- Target  : RHHF company only
-- Note    : These will be replaced by the accountant's Tally import before go-live
-- Run in  : Supabase SQL editor → project mmkbknnzgpvsqgnynrbe
-- Safe    : ON CONFLICT DO NOTHING — re-runnable
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Assumed system group UUIDs (check pramaana.ledger_groups for your actual values):
--
--   v_bank_grp  → group with code/name containing 'Bank'      (nature = asset)
--   v_cash_grp  → group with code/name containing 'Cash'      (nature = asset)
--   v_cred_grp  → group with code/name containing 'Creditor'  (nature = liability)
--   v_exp_grp   → group with code/name containing 'Indirect'  (nature = expense)
--
-- If your group UUIDs differ, replace the hardcoded UUIDs below with:
--   SELECT id FROM pramaana.ledger_groups WHERE name ILIKE '%Bank%' LIMIT 1;
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_company_id  UUID;
  v_bank_grp    UUID;
  v_cash_grp    UUID;
  v_cred_grp    UUID;
  v_exp_grp     UUID;
BEGIN
  -- Resolve company
  SELECT id INTO v_company_id
    FROM registry.companies
   WHERE code = 'RHHF'
     AND is_active = TRUE;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'RHHF company not found in registry.companies';
  END IF;

  -- Resolve group IDs dynamically (safer than hardcoded UUIDs)
  SELECT id INTO v_bank_grp FROM pramaana.ledger_groups
   WHERE name ILIKE '%bank%' AND (company_id IS NULL OR company_id = v_company_id)
   ORDER BY company_id NULLS LAST LIMIT 1;

  SELECT id INTO v_cash_grp FROM pramaana.ledger_groups
   WHERE name ILIKE '%cash%' AND (company_id IS NULL OR company_id = v_company_id)
   ORDER BY company_id NULLS LAST LIMIT 1;

  SELECT id INTO v_cred_grp FROM pramaana.ledger_groups
   WHERE (name ILIKE '%sundry creditor%' OR name ILIKE '%creditor%')
     AND (company_id IS NULL OR company_id = v_company_id)
   ORDER BY company_id NULLS LAST LIMIT 1;

  SELECT id INTO v_exp_grp FROM pramaana.ledger_groups
   WHERE (name ILIKE '%indirect expense%' OR name ILIKE '%indirect exp%')
     AND (company_id IS NULL OR company_id = v_company_id)
   ORDER BY company_id NULLS LAST LIMIT 1;

  -- Fallback: use first expense group if indirect not found
  IF v_exp_grp IS NULL THEN
    SELECT id INTO v_exp_grp FROM pramaana.ledger_groups
     WHERE name ILIKE '%expense%'
       AND (company_id IS NULL OR company_id = v_company_id)
     ORDER BY company_id NULLS LAST LIMIT 1;
  END IF;

  RAISE NOTICE 'company_id=%  bank_grp=%  cash_grp=%  cred_grp=%  exp_grp=%',
    v_company_id, v_bank_grp, v_cash_grp, v_cred_grp, v_exp_grp;

  -- Insert ledgers
  INSERT INTO pramaana.ledgers
    (company_id, group_id, name, tally_ledger_name,
     is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
  VALUES
    (v_company_id, v_bank_grp, 'SBI Current Account',  'SBI Current Account',  TRUE,  0, 'Dr', FALSE, TRUE),
    (v_company_id, v_cash_grp, 'Cash',                 'Cash',                 FALSE, 0, 'Dr', FALSE, TRUE),
    (v_company_id, v_cred_grp, 'Sundry Creditors',     'Sundry Creditors',     FALSE, 0, 'Cr', FALSE, TRUE),
    (v_company_id, v_exp_grp,  'Office Expenses',      'Office Expenses',      FALSE, 0, 'Dr', FALSE, TRUE),
    (v_company_id, v_exp_grp,  'Transport Expenses',   'Transport Expenses',   FALSE, 0, 'Dr', FALSE, TRUE)
  ON CONFLICT (company_id, name) DO NOTHING;

  RAISE NOTICE 'Seed complete — % ledgers inserted (duplicates skipped)',
    (SELECT COUNT(*) FROM pramaana.ledgers WHERE company_id = v_company_id AND is_system = FALSE);
END $$;

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT
  l.name,
  lg.name  AS group_name,
  lg.nature,
  l.is_bank_account,
  l.is_active
FROM pramaana.ledgers l
JOIN pramaana.ledger_groups lg ON lg.id = l.group_id
JOIN registry.companies c ON c.id = l.company_id
WHERE c.code = 'RHHF'
  AND l.is_system = FALSE
ORDER BY lg.nature, l.name;
