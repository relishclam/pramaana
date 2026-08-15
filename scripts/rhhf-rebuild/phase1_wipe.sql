-- ════════════════════════════════════════════════════════════════════════════
-- phase1_wipe.sql — RHHF Data Wipe
-- Strictly scoped to company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'.
-- RFPL is never touched.
--
-- Run in Supabase SQL Editor as service_role.
-- Record the RFPL PRE-WIPE counts (step 0) before proceeding.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
    RHHF_ID  CONSTANT UUID := 'b8beb440-df7f-48e8-a012-ac5750502eca';
    RFPL_ID  CONSTANT UUID := 'bc455c94-0bcd-4d66-a040-d29ed880d22f';

    v_rfpl_vouchers_pre  BIGINT;
    v_rfpl_entries_pre   BIGINT;
    v_rfpl_vouchers_post BIGINT;
    v_rfpl_entries_post  BIGINT;

    v_del_recon_matches      BIGINT := 0;
    v_del_recon_queries      BIGINT := 0;
    v_del_invoice_settle     BIGINT := 0;
    v_del_suspense_settle    BIGINT := 0;
    v_del_alloc              BIGINT := 0;
    v_del_entries            BIGINT := 0;
    v_del_vouchers           BIGINT := 0;
    v_reset_ledgers          BIGINT := 0;
    v_del_recon_txns         BIGINT := 0;
    v_del_recon_stmts        BIGINT := 0;
    v_del_bank_stmt_lines    BIGINT := 0;
    v_del_bank_stmts         BIGINT := 0;

BEGIN
    -- ── 0. RFPL pre-wipe snapshot (guard) ────────────────────────────────────
    SELECT count(*) INTO v_rfpl_vouchers_pre FROM pramaana.vouchers       WHERE company_id = RFPL_ID;
    SELECT count(*) INTO v_rfpl_entries_pre  FROM pramaana.voucher_entries WHERE voucher_id IN
        (SELECT id FROM pramaana.vouchers WHERE company_id = RFPL_ID);

    RAISE NOTICE 'PRE-WIPE RFPL snapshot — vouchers: %, entries: %',
        v_rfpl_vouchers_pre, v_rfpl_entries_pre;

    -- ── 0b. Disable posted-voucher guards for the wipe ──────────────────────
    ALTER TABLE pramaana.voucher_entries DISABLE TRIGGER USER;
    ALTER TABLE pramaana.vouchers        DISABLE TRIGGER USER;
    RAISE NOTICE 'Posted-voucher triggers disabled for wipe';

    -- ── 1. recon_matches (FK-safe: no downstream FKs) ───────────────────────
    DELETE FROM pramaana.recon_matches WHERE company_id = RHHF_ID;
    GET DIAGNOSTICS v_del_recon_matches = ROW_COUNT;
    RAISE NOTICE 'Deleted recon_matches: %', v_del_recon_matches;

    -- ── 2. recon_queries ─────────────────────────────────────────────────────
    DELETE FROM pramaana.recon_queries WHERE company_id = RHHF_ID;
    GET DIAGNOSTICS v_del_recon_queries = ROW_COUNT;
    RAISE NOTICE 'Deleted recon_queries: %', v_del_recon_queries;

    -- ── 3. invoice_settlements (company_id column; FK to vouchers dropped per 081) ──
    DELETE FROM pramaana.invoice_settlements WHERE company_id = RHHF_ID;
    GET DIAGNOSTICS v_del_invoice_settle = ROW_COUNT;
    RAISE NOTICE 'Deleted invoice_settlements: %', v_del_invoice_settle;

    -- ── 4. suspense_settlements (no company_id — link via voucher_id) ────────
    DELETE FROM pramaana.suspense_settlements
    WHERE advance_voucher_id IN (
        SELECT id FROM pramaana.vouchers WHERE company_id = RHHF_ID
    );
    GET DIAGNOSTICS v_del_suspense_settle = ROW_COUNT;
    RAISE NOTICE 'Deleted suspense_settlements: %', v_del_suspense_settle;

    -- ── 5. voucher_allocations / bill_allocations (company_id column) ────────
    --  (CASCADEs handle sub-rows; this covers any residual non-cascade rows)
    DELETE FROM pramaana.voucher_allocations WHERE company_id = RHHF_ID;
    GET DIAGNOSTICS v_del_alloc = ROW_COUNT;
    RAISE NOTICE 'Deleted voucher_allocations: %', v_del_alloc;

    -- ── 6. voucher_entries (CASCADE from vouchers handles this; belt-and-suspenders) ──
    DELETE FROM pramaana.voucher_entries
    WHERE voucher_id IN (SELECT id FROM pramaana.vouchers WHERE company_id = RHHF_ID);
    GET DIAGNOSTICS v_del_entries = ROW_COUNT;
    RAISE NOTICE 'Deleted voucher_entries: %', v_del_entries;

    -- ── 7. vouchers (CASCADEs: attachments, otp_sessions, gst_details, etc.) ─
    DELETE FROM pramaana.vouchers WHERE company_id = RHHF_ID;
    GET DIAGNOSTICS v_del_vouchers = ROW_COUNT;
    RAISE NOTICE 'Deleted vouchers: %', v_del_vouchers;

    -- ── 7b. Re-enable triggers ──────────────────────────────────────────────
    ALTER TABLE pramaana.voucher_entries ENABLE TRIGGER USER;
    ALTER TABLE pramaana.vouchers        ENABLE TRIGGER USER;
    RAISE NOTICE 'Posted-voucher triggers re-enabled';

    -- ── 8. Reset opening_balance on all RHHF ledgers ─────────────────────────
    UPDATE pramaana.ledgers
       SET opening_balance = 0,
           opening_dr_cr   = 'Dr'
     WHERE company_id = RHHF_ID;
    GET DIAGNOSTICS v_reset_ledgers = ROW_COUNT;
    RAISE NOTICE 'Reset opening_balance on % RHHF ledgers', v_reset_ledgers;

    -- ── 9. New recon staging: recon_transactions → recon_statements ──────────
    DELETE FROM pramaana.recon_transactions
    WHERE statement_id IN (
        SELECT id FROM pramaana.recon_statements WHERE company_id = RHHF_ID
    );
    GET DIAGNOSTICS v_del_recon_txns = ROW_COUNT;
    RAISE NOTICE 'Deleted recon_transactions: %', v_del_recon_txns;

    DELETE FROM pramaana.recon_statements WHERE company_id = RHHF_ID;
    GET DIAGNOSTICS v_del_recon_stmts = ROW_COUNT;
    RAISE NOTICE 'Deleted recon_statements: %', v_del_recon_stmts;

    -- ── 10. Old bank staging (IF tables exist — pre-072 schema) ──────────────
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'pramaana' AND table_name = 'bank_statement_lines'
    ) THEN
        EXECUTE format(
            'DELETE FROM pramaana.bank_statement_lines WHERE company_id = %L',
            RHHF_ID
        );
        GET DIAGNOSTICS v_del_bank_stmt_lines = ROW_COUNT;
        RAISE NOTICE 'Deleted bank_statement_lines (legacy): %', v_del_bank_stmt_lines;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'pramaana' AND table_name = 'bank_statements'
    ) THEN
        EXECUTE format(
            'DELETE FROM pramaana.bank_statements WHERE company_id = %L',
            RHHF_ID
        );
        GET DIAGNOSTICS v_del_bank_stmts = ROW_COUNT;
        RAISE NOTICE 'Deleted bank_statements (legacy): %', v_del_bank_stmts;
    END IF;

    -- ── 11. RFPL post-wipe verification ──────────────────────────────────────
    SELECT count(*) INTO v_rfpl_vouchers_post FROM pramaana.vouchers       WHERE company_id = RFPL_ID;
    SELECT count(*) INTO v_rfpl_entries_post  FROM pramaana.voucher_entries WHERE voucher_id IN
        (SELECT id FROM pramaana.vouchers WHERE company_id = RFPL_ID);

    RAISE NOTICE 'POST-WIPE RFPL snapshot — vouchers: %, entries: %',
        v_rfpl_vouchers_post, v_rfpl_entries_post;

    IF v_rfpl_vouchers_post <> v_rfpl_vouchers_pre OR v_rfpl_entries_post <> v_rfpl_entries_pre THEN
        RAISE EXCEPTION 'RFPL DATA CHANGED — wipe touched RFPL! PRE: v=% e=%, POST: v=% e=%',
            v_rfpl_vouchers_pre, v_rfpl_entries_pre,
            v_rfpl_vouchers_post, v_rfpl_entries_post;
    END IF;

    RAISE NOTICE '✓ RFPL data intact (pre = post)';

    -- ── 12. Post-wipe RHHF zero-check ────────────────────────────────────────
    DECLARE
        v_rhhf_v BIGINT;
        v_rhhf_e BIGINT;
        v_rhhf_ob_nonzero BIGINT;
    BEGIN
        SELECT count(*) INTO v_rhhf_v FROM pramaana.vouchers WHERE company_id = RHHF_ID;
        SELECT count(*) INTO v_rhhf_e FROM pramaana.voucher_entries
        WHERE voucher_id IN (SELECT id FROM pramaana.vouchers WHERE company_id = RHHF_ID);
        SELECT count(*) INTO v_rhhf_ob_nonzero FROM pramaana.ledgers
        WHERE company_id = RHHF_ID AND opening_balance <> 0;

        IF v_rhhf_v > 0 OR v_rhhf_e > 0 THEN
            RAISE EXCEPTION 'RHHF wipe incomplete: % vouchers, % entries remain', v_rhhf_v, v_rhhf_e;
        END IF;

        RAISE NOTICE '✓ RHHF wipe complete: vouchers=%, entries=%, non-zero OBs=%',
            v_rhhf_v, v_rhhf_e, v_rhhf_ob_nonzero;
    END;

END;
$$;

-- ── Final count verification query ───────────────────────────────────────────
SELECT
    c.code                                                AS entity,
    count(DISTINCT v.id)                                  AS vouchers,
    count(DISTINCT e.id)                                  AS entries,
    (SELECT count(*) FROM pramaana.ledgers l
      WHERE l.company_id = c.id AND l.opening_balance <> 0) AS nonzero_opening_balances
FROM registry.companies c
LEFT JOIN pramaana.vouchers        v ON v.company_id = c.id
LEFT JOIN pramaana.voucher_entries e ON e.voucher_id = v.id
WHERE c.id IN (
    'b8beb440-df7f-48e8-a012-ac5750502eca',
    'bc455c94-0bcd-4d66-a040-d29ed880d22f'
)
GROUP BY c.code, c.id
ORDER BY c.code;
