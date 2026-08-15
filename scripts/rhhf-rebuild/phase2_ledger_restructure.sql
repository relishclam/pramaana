-- ════════════════════════════════════════════════════════════════════════════
-- phase2_ledger_restructure.sql — RHHF Ledger Rename / Regroup / Create
-- Idempotent: safe to re-run.  All changes are scoped to RHHF.
--
-- What this does:
--   A) Rename bank ledgers to match audited account names
--   B) Regroup KSIDC from Bank Accounts → Secured Loans (liability)
--   C) Rename capital / cash / suspense ledgers
--   D) Split "Sundry Creditors" → 3 advance ledgers (Current Assets)
--   E) Rename GST/Duties ledgers → GST Input Tax Credit (Current Assets)
--   F) Create new ledgers: advance splits, GST ITC, Opening Adjustment
--
-- Run in Supabase SQL Editor AFTER phase1_wipe.sql.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
    RHHF_ID CONSTANT UUID := 'b8beb440-df7f-48e8-a012-ac5750502eca';

    -- Group IDs resolved dynamically
    v_bank_grp       UUID;
    v_loan_parent    UUID;
    v_cash_grp       UUID;
    v_capital_grp    UUID;
    v_secured_loan   UUID;    -- Secured Loans (Liability)
    v_curr_asset_grp UUID;    -- Current Assets / Loans & Advances
    v_fixed_asset_grp UUID;   -- Fixed Assets
    v_suspense_grp   UUID;
    v_indirect_exp   UUID;    -- Indirect Expenses
    v_pl_grp         UUID;    -- P&L / Reserves

    -- Ledger IDs resolved by lookup
    v_hdfc_current  UUID;   -- acct 99999446012324
    v_hdfc_nolien   UUID;   -- acct 50200115901702
    v_sweep_fd      UUID;
    v_ksidc         UUID;
    v_motty_cap     UUID;
    v_motty_curr    UUID;
    v_tarun_cap     UUID;
    v_cash          UUID;
    v_sundry_cred   UUID;
    v_suspense      UUID;
    v_duties_tax    UUID;   -- Duties & Taxes / GST combined ledger (if any)
    v_cgst          UUID;
    v_sgst          UUID;
    v_existing      UUID;

BEGIN
    -- ═══════════════════════════════════════════════════════
    -- RESOLVE LEDGER GROUPS
    -- ═══════════════════════════════════════════════════════

    -- Bank Accounts (system group, company_id IS NULL)
    SELECT id INTO v_bank_grp FROM pramaana.ledger_groups
    WHERE name = 'Bank Accounts' AND (company_id IS NULL OR company_id = RHHF_ID)
    ORDER BY company_id NULLS LAST LIMIT 1;
    IF v_bank_grp IS NULL THEN RAISE EXCEPTION 'Ledger group "Bank Accounts" not found'; END IF;

    -- Cash / Cash in Hand
    SELECT id INTO v_cash_grp FROM pramaana.ledger_groups
    WHERE name ILIKE '%cash%' AND (company_id IS NULL OR company_id = RHHF_ID)
    ORDER BY company_id NULLS LAST LIMIT 1;
    IF v_cash_grp IS NULL THEN RAISE EXCEPTION 'Ledger group "Cash" not found'; END IF;

    -- Capital Accounts
    SELECT id INTO v_capital_grp FROM pramaana.ledger_groups
    WHERE name ILIKE '%capital%' AND (company_id IS NULL OR company_id = RHHF_ID)
    ORDER BY company_id NULLS LAST LIMIT 1;
    IF v_capital_grp IS NULL THEN RAISE EXCEPTION 'Ledger group "Capital" not found'; END IF;

    -- Current Assets / Loans & Advances (for advance ledgers and GST ITC)
    SELECT id INTO v_curr_asset_grp FROM pramaana.ledger_groups
    WHERE (name ILIKE '%current asset%' OR name ILIKE '%loans & advance%' OR name ILIKE '%loans and advance%')
      AND (company_id IS NULL OR company_id = RHHF_ID)
    ORDER BY company_id NULLS LAST LIMIT 1;
    IF v_curr_asset_grp IS NULL THEN RAISE EXCEPTION 'Ledger group "Current Assets / Loans & Advances" not found'; END IF;

    -- Fixed Assets
    SELECT id INTO v_fixed_asset_grp FROM pramaana.ledger_groups
    WHERE (name ILIKE '%fixed asset%' OR name ILIKE '%capital expenditure%')
      AND (company_id IS NULL OR company_id = RHHF_ID)
    ORDER BY company_id NULLS LAST LIMIT 1;
    IF v_fixed_asset_grp IS NULL THEN RAISE EXCEPTION 'Ledger group "Fixed Assets" not found'; END IF;

    -- Suspense
    SELECT id INTO v_suspense_grp FROM pramaana.ledger_groups
    WHERE name ILIKE '%suspense%' AND (company_id IS NULL OR company_id = RHHF_ID)
    ORDER BY company_id NULLS LAST LIMIT 1;
    IF v_suspense_grp IS NULL THEN RAISE EXCEPTION 'Ledger group "Suspense" not found'; END IF;

    -- Secured Loans (Liability) — may be named "Secured Loans" or "Loan (Liability)"
    SELECT id INTO v_secured_loan FROM pramaana.ledger_groups
    WHERE (name ILIKE '%secured loan%' OR name ILIKE '%loan%liabilit%' OR name ILIKE '%term loan%')
      AND (company_id IS NULL OR company_id = RHHF_ID)
    ORDER BY company_id NULLS LAST LIMIT 1;

    -- If Secured Loans group does not exist, create it as a company-scoped group
    IF v_secured_loan IS NULL THEN
        SELECT id INTO v_loan_parent FROM pramaana.ledger_groups
        WHERE name ILIKE '%loan%' AND company_id IS NULL LIMIT 1;

        INSERT INTO pramaana.ledger_groups (company_id, name, nature, parent_id)
        VALUES (RHHF_ID, 'Secured Loans', 'LIABILITY', v_loan_parent)
        ON CONFLICT DO NOTHING
        RETURNING id INTO v_secured_loan;

        -- If conflict, fetch the just-created row
        IF v_secured_loan IS NULL THEN
            SELECT id INTO v_secured_loan FROM pramaana.ledger_groups
            WHERE company_id = RHHF_ID AND name = 'Secured Loans';
        END IF;
        RAISE NOTICE 'Created ledger group: Secured Loans (company-scoped)';
    END IF;

    -- Indirect Expenses
    SELECT id INTO v_indirect_exp FROM pramaana.ledger_groups
    WHERE (name ILIKE '%indirect%expense%' OR name ILIKE '%indirect exp%')
      AND (company_id IS NULL OR company_id = RHHF_ID)
    ORDER BY company_id NULLS LAST LIMIT 1;
    IF v_indirect_exp IS NULL THEN
        SELECT id INTO v_indirect_exp FROM pramaana.ledger_groups
        WHERE name ILIKE '%expense%' AND (company_id IS NULL OR company_id = RHHF_ID)
        ORDER BY company_id NULLS LAST LIMIT 1;
    END IF;

    -- P&L / Reserves
    SELECT id INTO v_pl_grp FROM pramaana.ledger_groups
    WHERE (name ILIKE '%reserve%' OR name ILIKE '%p&l%' OR name ILIKE '%profit%loss%' OR name ILIKE '%retained%')
      AND (company_id IS NULL OR company_id = RHHF_ID)
    ORDER BY company_id NULLS LAST LIMIT 1;
    -- Fallback to capital group for P&L carry-forward
    IF v_pl_grp IS NULL THEN v_pl_grp := v_capital_grp; END IF;

    RAISE NOTICE 'Groups — bank:% cash:% capital:% secured_loan:% curr_asset:% fixed_asset:% suspense:% indirect:%',
        v_bank_grp, v_cash_grp, v_capital_grp, v_secured_loan,
        v_curr_asset_grp, v_fixed_asset_grp, v_suspense_grp, v_indirect_exp;

    -- ═══════════════════════════════════════════════════════
    -- A. BANK LEDGERS — rename to audited account names
    -- ═══════════════════════════════════════════════════════

    -- HDFC Current A/c 2324 (account_number = 99999446012324)
    SELECT id INTO v_hdfc_current FROM pramaana.ledgers
    WHERE company_id = RHHF_ID
      AND (account_number = '99999446012324'
           OR tally_ledger_name ILIKE '%HDFC Bank%'
           OR name ILIKE '%99999446012324%'
           OR (name ILIKE '%HDFC%current%' AND name NOT ILIKE '%no-lien%' AND name NOT ILIKE '%1702%'))
    ORDER BY
        CASE WHEN account_number = '99999446012324' THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_hdfc_current IS NOT NULL THEN
        UPDATE pramaana.ledgers
           SET name              = 'HDFC Current A/c 2324',
               tally_ledger_name = 'HDFC Bank',
               group_id          = v_bank_grp,
               account_number    = '99999446012324'
         WHERE id = v_hdfc_current
           AND (name <> 'HDFC Current A/c 2324');  -- skip if already renamed
        RAISE NOTICE 'Renamed HDFC Current ledger (acct 2324)';
    ELSE
        RAISE WARNING 'HDFC Current A/c 2324 not found — create manually or check account_number';
    END IF;

    -- HDFC No-Lien A/c 1702 (account_number = 50200115901702)
    SELECT id INTO v_hdfc_nolien FROM pramaana.ledgers
    WHERE company_id = RHHF_ID
      AND (account_number = '50200115901702'
           OR tally_ledger_name ILIKE '%HDFC BANK ABM%'
           OR name ILIKE '%50200115901702%'
           OR name ILIKE '%no-lien%'
           OR name ILIKE '%1702%')
    ORDER BY
        CASE WHEN account_number = '50200115901702' THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_hdfc_nolien IS NOT NULL THEN
        UPDATE pramaana.ledgers
           SET name              = 'HDFC No-Lien A/c 1702',
               tally_ledger_name = 'HDFC BANK ABM',
               group_id          = v_bank_grp,
               account_number    = '50200115901702'
         WHERE id = v_hdfc_nolien
           AND (name <> 'HDFC No-Lien A/c 1702');
        RAISE NOTICE 'Renamed HDFC No-Lien ledger (acct 1702)';
    ELSE
        RAISE WARNING 'HDFC No-Lien A/c 1702 not found — check account_number 50200115901702';
    END IF;

    -- HDFC Sweep FD
    SELECT id INTO v_sweep_fd FROM pramaana.ledgers
    WHERE company_id = RHHF_ID
      AND (tally_ledger_name ILIKE '%sweep%fd%'
           OR tally_ledger_name ILIKE '%sweep out fd%'
           OR name ILIKE '%sweep%')
    LIMIT 1;

    IF v_sweep_fd IS NOT NULL THEN
        UPDATE pramaana.ledgers
           SET name              = 'HDFC Sweep FD',
               tally_ledger_name = 'Sweep Out Fd Accounts'
         WHERE id = v_sweep_fd AND name <> 'HDFC Sweep FD';
        RAISE NOTICE 'Renamed HDFC Sweep FD ledger';
    ELSE
        -- Create if doesn't exist
        INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
            is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
        SELECT RHHF_ID, v_bank_grp, 'HDFC Sweep FD', 'Sweep Out Fd Accounts',
               FALSE, 0, 'Cr', FALSE, TRUE
        WHERE NOT EXISTS (
            SELECT 1 FROM pramaana.ledgers WHERE company_id = RHHF_ID AND name = 'HDFC Sweep FD'
        );
        RAISE NOTICE 'Created HDFC Sweep FD ledger';
    END IF;

    -- ═══════════════════════════════════════════════════════
    -- B. KSIDC — regroup from Bank Accounts → Secured Loans
    -- ═══════════════════════════════════════════════════════

    SELECT id INTO v_ksidc FROM pramaana.ledgers
    WHERE company_id = RHHF_ID
      AND (tally_ledger_name ILIKE '%KSIDC%'
           OR name ILIKE '%KSIDC%')
    LIMIT 1;

    IF v_ksidc IS NOT NULL THEN
        UPDATE pramaana.ledgers
           SET name              = 'KSIDC Term Loan',
               tally_ledger_name = 'KSIDC LTD-',
               group_id          = v_secured_loan,
               is_bank_account   = FALSE
         WHERE id = v_ksidc;
        RAISE NOTICE 'KSIDC: renamed + regrouped → Secured Loans';
    ELSE
        INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
            is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
        SELECT RHHF_ID, v_secured_loan, 'KSIDC Term Loan', 'KSIDC LTD-',
               FALSE, 0, 'Cr', FALSE, TRUE
        WHERE NOT EXISTS (
            SELECT 1 FROM pramaana.ledgers WHERE company_id = RHHF_ID AND name = 'KSIDC Term Loan'
        );
        RAISE NOTICE 'KSIDC Term Loan: created (was not found by tally_ledger_name)';
    END IF;

    -- ═══════════════════════════════════════════════════════
    -- C. CAPITAL / CASH / SUSPENSE RENAMES
    -- ═══════════════════════════════════════════════════════

    -- Motty Philip — Capital
    SELECT id INTO v_motty_cap FROM pramaana.ledgers
    WHERE company_id = RHHF_ID
      AND (tally_ledger_name ILIKE '%MOTTY PHILIP%Capital%'
           OR name ILIKE '%Motty%Capital%')
    LIMIT 1;
    IF v_motty_cap IS NOT NULL THEN
        UPDATE pramaana.ledgers SET name = 'Motty Philip — Capital', group_id = v_capital_grp
        WHERE id = v_motty_cap AND name <> 'Motty Philip — Capital';
        RAISE NOTICE 'Renamed: Motty Philip — Capital';
    ELSE
        INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
            is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
        SELECT RHHF_ID, v_capital_grp, 'Motty Philip — Capital', 'MOTTY PHILIP -Capital Account',
               FALSE, 0, 'Cr', FALSE, TRUE
        WHERE NOT EXISTS (
            SELECT 1 FROM pramaana.ledgers WHERE company_id = RHHF_ID AND name = 'Motty Philip — Capital'
        );
        RAISE NOTICE 'Created: Motty Philip — Capital';
    END IF;

    -- Motty Philip — Current
    SELECT id INTO v_motty_curr FROM pramaana.ledgers
    WHERE company_id = RHHF_ID
      AND (tally_ledger_name ILIKE '%MOTTY PHILIP%Current%'
           OR name ILIKE '%Motty%Current%')
    LIMIT 1;
    IF v_motty_curr IS NOT NULL THEN
        UPDATE pramaana.ledgers SET name = 'Motty Philip — Current', group_id = v_capital_grp
        WHERE id = v_motty_curr AND name <> 'Motty Philip — Current';
        RAISE NOTICE 'Renamed: Motty Philip — Current';
    ELSE
        INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
            is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
        SELECT RHHF_ID, v_capital_grp, 'Motty Philip — Current', 'MOTTY PHILIP Current Account',
               FALSE, 0, 'Cr', FALSE, TRUE
        WHERE NOT EXISTS (
            SELECT 1 FROM pramaana.ledgers WHERE company_id = RHHF_ID AND name = 'Motty Philip — Current'
        );
        RAISE NOTICE 'Created: Motty Philip — Current';
    END IF;

    -- Tarun Philip — Capital
    SELECT id INTO v_tarun_cap FROM pramaana.ledgers
    WHERE company_id = RHHF_ID
      AND (tally_ledger_name ILIKE '%TARUN PHILIP%'
           OR name ILIKE '%Tarun%Capital%')
    LIMIT 1;
    IF v_tarun_cap IS NOT NULL THEN
        UPDATE pramaana.ledgers SET name = 'Tarun Philip — Capital', group_id = v_capital_grp
        WHERE id = v_tarun_cap AND name <> 'Tarun Philip — Capital';
        RAISE NOTICE 'Renamed: Tarun Philip — Capital';
    ELSE
        INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
            is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
        SELECT RHHF_ID, v_capital_grp, 'Tarun Philip — Capital', 'TARUN PHILIP- Capital Account',
               FALSE, 0, 'Cr', FALSE, TRUE
        WHERE NOT EXISTS (
            SELECT 1 FROM pramaana.ledgers WHERE company_id = RHHF_ID AND name = 'Tarun Philip — Capital'
        );
        RAISE NOTICE 'Created: Tarun Philip — Capital';
    END IF;

    -- Cash in Hand
    SELECT id INTO v_cash FROM pramaana.ledgers
    WHERE company_id = RHHF_ID
      AND (tally_ledger_name ILIKE '%^cash$%' OR tally_ledger_name = 'Cash' OR name = 'Cash'
           OR (name ILIKE '%cash%' AND name NOT ILIKE '%bank%'))
    LIMIT 1;
    IF v_cash IS NOT NULL THEN
        UPDATE pramaana.ledgers SET name = 'Cash in Hand', group_id = v_cash_grp
        WHERE id = v_cash AND name <> 'Cash in Hand';
        RAISE NOTICE 'Renamed: Cash in Hand';
    ELSE
        INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
            is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
        SELECT RHHF_ID, v_cash_grp, 'Cash in Hand', 'Cash',
               FALSE, 0, 'Dr', FALSE, TRUE
        WHERE NOT EXISTS (
            SELECT 1 FROM pramaana.ledgers WHERE company_id = RHHF_ID AND name = 'Cash in Hand'
        );
        RAISE NOTICE 'Created: Cash in Hand';
    END IF;

    -- Suspense — Sangeetha (SUS-2026-27-00002)
    SELECT id INTO v_suspense FROM pramaana.ledgers
    WHERE company_id = RHHF_ID
      AND (name ILIKE '%Suspense%Sangeetha%'
           OR (name ILIKE '%Suspense%' AND tally_ledger_name ILIKE '%Suspense%')
           OR tally_ledger_name = 'Suspense')
    ORDER BY
        CASE WHEN name ILIKE '%Sangeetha%' THEN 0
             WHEN name = 'Suspense' THEN 1
             ELSE 2 END
    LIMIT 1;
    IF v_suspense IS NOT NULL THEN
        UPDATE pramaana.ledgers
           SET name = 'Suspense — Sangeetha (SUS-2026-27-00002)',
               group_id = v_suspense_grp
         WHERE id = v_suspense AND name <> 'Suspense — Sangeetha (SUS-2026-27-00002)';
        RAISE NOTICE 'Renamed: Suspense — Sangeetha (SUS-2026-27-00002)';
    ELSE
        INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
            is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
        SELECT RHHF_ID, v_suspense_grp, 'Suspense — Sangeetha (SUS-2026-27-00002)', 'Suspense',
               FALSE, 0, 'Dr', FALSE, TRUE
        WHERE NOT EXISTS (
            SELECT 1 FROM pramaana.ledgers
            WHERE company_id = RHHF_ID AND name = 'Suspense — Sangeetha (SUS-2026-27-00002)'
        );
        RAISE NOTICE 'Created: Suspense — Sangeetha (SUS-2026-27-00002)';
    END IF;

    -- ═══════════════════════════════════════════════════════
    -- D. SUNDRY CREDITORS SPLIT → 3 advance ledgers
    --    The original "Sundry Creditors" lump (Dr ₹57,43,478.44) is
    --    an advance, not a creditor.  Rename it to the residual ledger
    --    and create the two named advance ledgers.
    -- ═══════════════════════════════════════════════════════

    SELECT id INTO v_sundry_cred FROM pramaana.ledgers
    WHERE company_id = RHHF_ID
      AND (name = 'Sundry Creditors'
           OR tally_ledger_name = 'Sundry Creditors'
           OR name ILIKE '%sundry creditor%')
    LIMIT 1;

    IF v_sundry_cred IS NOT NULL THEN
        -- Repurpose the existing ledger as "Advance — Building Materials" (residual)
        UPDATE pramaana.ledgers
           SET name              = 'Advance — Building Materials',
               tally_ledger_name = 'Sundry Creditors',
               group_id          = v_curr_asset_grp
         WHERE id = v_sundry_cred AND name <> 'Advance — Building Materials';
        RAISE NOTICE 'Repurposed Sundry Creditors → Advance — Building Materials';
    END IF;

    -- Advance to Mitra Constructions
    INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
        is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
    SELECT RHHF_ID, v_curr_asset_grp, 'Advance to Mitra Constructions', 'Advance to Mitra Constructions',
           FALSE, 0, 'Dr', FALSE, TRUE
    WHERE NOT EXISTS (
        SELECT 1 FROM pramaana.ledgers
        WHERE company_id = RHHF_ID AND name = 'Advance to Mitra Constructions'
    );

    -- Advance to Drishya Engineering
    INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
        is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
    SELECT RHHF_ID, v_curr_asset_grp, 'Advance to Drishya Engineering', 'Advance to Drishya Engineering',
           FALSE, 0, 'Dr', FALSE, TRUE
    WHERE NOT EXISTS (
        SELECT 1 FROM pramaana.ledgers
        WHERE company_id = RHHF_ID AND name = 'Advance to Drishya Engineering'
    );

    RAISE NOTICE 'Advance ledgers: Mitra and Drishya ensured';

    -- Rent Advance (Deposit) — ensure it exists in Current Assets
    INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
        is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
    SELECT RHHF_ID, v_curr_asset_grp, 'Rent Advance (Deposit)', 'Rent Advance (Deposit)',
           FALSE, 0, 'Dr', FALSE, TRUE
    WHERE NOT EXISTS (
        SELECT 1 FROM pramaana.ledgers
        WHERE company_id = RHHF_ID AND name ILIKE '%Rent Advance%'
    );

    -- ═══════════════════════════════════════════════════════
    -- E. GST / DUTIES & TAXES → GST Input Tax Credit
    --    Dr balance = ITC asset, not a liability.
    --    Rename Duties & Taxes CGST/SGST ledgers or create them.
    -- ═══════════════════════════════════════════════════════

    -- CGST ITC
    SELECT id INTO v_cgst FROM pramaana.ledgers
    WHERE company_id = RHHF_ID
      AND (name ILIKE '%CGST%' OR tally_ledger_name ILIKE '%CGST%'
           OR name ILIKE '%GST%CGST%')
    LIMIT 1;
    IF v_cgst IS NOT NULL THEN
        UPDATE pramaana.ledgers
           SET name     = 'GST Input Tax Credit — CGST',
               group_id = v_curr_asset_grp
         WHERE id = v_cgst AND name <> 'GST Input Tax Credit — CGST';
        RAISE NOTICE 'Renamed: GST Input Tax Credit — CGST';
    ELSE
        INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
            is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
        SELECT RHHF_ID, v_curr_asset_grp, 'GST Input Tax Credit — CGST', 'CGST',
               FALSE, 0, 'Dr', FALSE, TRUE
        WHERE NOT EXISTS (
            SELECT 1 FROM pramaana.ledgers
            WHERE company_id = RHHF_ID AND name = 'GST Input Tax Credit — CGST'
        );
        RAISE NOTICE 'Created: GST Input Tax Credit — CGST';
    END IF;

    -- SGST ITC
    SELECT id INTO v_sgst FROM pramaana.ledgers
    WHERE company_id = RHHF_ID
      AND (name ILIKE '%SGST%' OR tally_ledger_name ILIKE '%SGST%'
           OR name ILIKE '%GST%SGST%')
    LIMIT 1;
    IF v_sgst IS NOT NULL THEN
        UPDATE pramaana.ledgers
           SET name     = 'GST Input Tax Credit — SGST',
               group_id = v_curr_asset_grp
         WHERE id = v_sgst AND name <> 'GST Input Tax Credit — SGST';
        RAISE NOTICE 'Renamed: GST Input Tax Credit — SGST';
    ELSE
        INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
            is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
        SELECT RHHF_ID, v_curr_asset_grp, 'GST Input Tax Credit — SGST', 'SGST',
               FALSE, 0, 'Dr', FALSE, TRUE
        WHERE NOT EXISTS (
            SELECT 1 FROM pramaana.ledgers
            WHERE company_id = RHHF_ID AND name = 'GST Input Tax Credit — SGST'
        );
        RAISE NOTICE 'Created: GST Input Tax Credit — SGST';
    END IF;

    -- Duties & Taxes combined ledger (if any) — regroup to current assets if Dr
    SELECT id INTO v_duties_tax FROM pramaana.ledgers
    WHERE company_id = RHHF_ID
      AND (name ILIKE '%duties%tax%' OR tally_ledger_name ILIKE '%duties%tax%')
      AND name NOT ILIKE '%CGST%'
      AND name NOT ILIKE '%SGST%'
    LIMIT 1;
    IF v_duties_tax IS NOT NULL THEN
        UPDATE pramaana.ledgers
           SET group_id = v_curr_asset_grp
         WHERE id = v_duties_tax;
        RAISE NOTICE 'Regrouped Duties & Taxes combined ledger → Current Assets';
    END IF;

    -- ═══════════════════════════════════════════════════════
    -- F. NEW LEDGERS: Opening Adjustment + P&L
    -- ═══════════════════════════════════════════════════════

    -- Opening Adjustment (to clear) — carry as visible ledger per Motty's instruction
    INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
        is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
    SELECT RHHF_ID, v_capital_grp, 'Opening Adjustment (to clear)', 'Opening Adjustment (to clear)',
           FALSE, 0, 'Dr', FALSE, TRUE
    WHERE NOT EXISTS (
        SELECT 1 FROM pramaana.ledgers
        WHERE company_id = RHHF_ID AND name = 'Opening Adjustment (to clear)'
    );

    -- P&L A/c (accumulated pre-Nov balance)
    INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name,
        is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
    SELECT RHHF_ID, v_pl_grp, 'P&L A/c', 'P&L A/c',
           FALSE, 0, 'Dr', FALSE, TRUE
    WHERE NOT EXISTS (
        SELECT 1 FROM pramaana.ledgers
        WHERE company_id = RHHF_ID AND (name = 'P&L A/c' OR name ILIKE '%profit%loss%')
    );

    RAISE NOTICE '✓ Phase 2 ledger restructure complete';

END;
$$;

-- ── Verification query — review before proceeding to Phase 3 ─────────────────
SELECT
    l.name,
    lg.name   AS group_name,
    lg.nature AS group_nature,
    l.is_bank_account,
    l.account_number,
    l.opening_balance,
    l.opening_dr_cr,
    l.is_active
FROM  pramaana.ledgers l
JOIN  pramaana.ledger_groups lg ON lg.id = l.group_id
WHERE l.company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
ORDER BY lg.nature, lg.name, l.name;
