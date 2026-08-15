-- ════════════════════════════════════════════════════════════════════════════
-- phase2b_cleanup.sql — Phase 2 post-run cleanup
-- Run in Supabase SQL Editor immediately after inspecting Phase 2 output.
--
-- Fixes:
--   1. Delete duplicate capital ledgers whose renames left the old row behind
--   2. Create "Advance — Building Materials" (no lump Sundry Creditors existed)
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
    RHHF_ID  CONSTANT UUID := 'b8beb440-df7f-48e8-a012-ac5750502eca';
    v_curr_asset_grp UUID;
    v_deleted        BIGINT;
BEGIN
    -- ── 1. Deactivate zombie original-name capital ledgers ───────────────────
    -- The renamed counterparts already exist; set is_active=false so no new
    -- vouchers can be keyed to the old names, but history is preserved.
    UPDATE pramaana.ledgers
       SET is_active = false
     WHERE company_id = RHHF_ID
       AND name IN ('MOTTY PHILIP Current Account', 'TARUN PHILIP- Capital Account');
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE 'Deactivated % zombie original-name capital ledger(s)', v_deleted;

    -- ── 2. Create Advance — Building Materials ───────────────────────────────
    -- No lump "Sundry Creditors" row existed to repurpose; individual party rows
    -- were imported instead.  Create the residual advance ledger fresh.
    SELECT id INTO v_curr_asset_grp FROM pramaana.ledger_groups
    WHERE name ILIKE '%current asset%'
      AND (company_id IS NULL OR company_id = RHHF_ID)
    ORDER BY company_id NULLS LAST LIMIT 1;

    IF v_curr_asset_grp IS NULL THEN
        RAISE EXCEPTION 'Current Assets group not found';
    END IF;

    INSERT INTO pramaana.ledgers
        (company_id, group_id, name, tally_ledger_name,
         is_bank_account, opening_balance, opening_dr_cr, is_system, is_active)
    SELECT RHHF_ID, v_curr_asset_grp,
           'Advance — Building Materials', 'Sundry Creditors',
           FALSE, 0, 'Dr', FALSE, TRUE
    WHERE NOT EXISTS (
        SELECT 1 FROM pramaana.ledgers
        WHERE company_id = RHHF_ID AND name = 'Advance — Building Materials'
    );
    RAISE NOTICE 'Advance — Building Materials: ensured';

    RAISE NOTICE '✓ Phase 2b cleanup complete';
END;
$$;

-- ── Verify: capital group should now have exactly 4 ledgers ──────────────────
SELECT name, group_name, opening_balance
FROM (
    SELECT l.name, lg.name AS group_name, l.opening_balance
    FROM pramaana.ledgers l
    JOIN pramaana.ledger_groups lg ON lg.id = l.group_id
    WHERE l.company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
      AND lg.name ILIKE '%capital%'
) t
ORDER BY name;
