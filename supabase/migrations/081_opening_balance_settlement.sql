-- ════════════════════════════════════════════════════════════════
-- 081_opening_balance_settlement.sql
--
-- Problem:
--   get_outstanding_invoices (migration 080) returns a synthetic
--   "Opening Balance" row whose voucher_id = ledger.id (a UUID that
--   exists in pramaana.ledgers, not pramaana.vouchers).
--
--   Two things block posting a settlement against it:
--
--   1. invoice_settlements.invoice_voucher_id has a FK →
--      pramaana.vouchers(id).  Inserting a ledger UUID violates it.
--
--   2. post_settlement_receipt validates the document by querying
--      pramaana.vouchers WHERE id = p_invoice_voucher_id, which finds
--      nothing for a ledger UUID and raises "document not found".
--
-- Fix:
--   1. Drop the FK on invoice_settlements.invoice_voucher_id.
--      (Outstanding is always derived on the fly — the FK was a
--       structural guard only.  get_outstanding_invoices already
--       enforces that only real balances are presented.)
--
--   2. Replace post_settlement_receipt so that:
--      • It validates open balance via get_outstanding_invoices,
--        which handles both real SALE voucher IDs AND the synthetic
--        ledger-UUID opening balance row.
--      • All other logic is unchanged.
-- ════════════════════════════════════════════════════════════════

-- ── 1. Drop FK on invoice_settlements.invoice_voucher_id ─────────────────────

DO $$
DECLARE
    v_constraint TEXT;
BEGIN
    SELECT tc.constraint_name INTO v_constraint
    FROM   information_schema.table_constraints tc
    JOIN   information_schema.key_column_usage   kcu
           ON  kcu.constraint_name = tc.constraint_name
           AND kcu.table_schema    = tc.table_schema
           AND kcu.table_name      = tc.table_name
    WHERE  tc.table_schema    = 'pramaana'
      AND  tc.table_name      = 'invoice_settlements'
      AND  tc.constraint_type = 'FOREIGN KEY'
      AND  kcu.column_name    = 'invoice_voucher_id'
    LIMIT 1;

    IF v_constraint IS NOT NULL THEN
        EXECUTE format(
            'ALTER TABLE pramaana.invoice_settlements DROP CONSTRAINT %I',
            v_constraint
        );
        RAISE NOTICE 'Dropped FK constraint: %', v_constraint;
    ELSE
        RAISE NOTICE 'invoice_settlements.invoice_voucher_id has no FK — nothing to drop';
    END IF;
END;
$$;

-- ── 2. Replace post_settlement_receipt ───────────────────────────────────────
--
-- Parameter contract (unchanged from the original):
--   p_company_id         UUID
--   p_created_by         UUID
--   p_party_ledger_id    UUID
--   p_invoice_voucher_id UUID   ← may be a voucher UUID or a ledger UUID
--                                  (opening balance synthetic row)
--   p_bank_lines         JSONB  ← [{bank_ledger_id, receipt_date, amount,
--                                    bank_reference}]
--   p_tds_amount         NUMERIC (default 0)
--   p_tds_ledger_id      UUID    (default NULL)
--   p_tds_section_code   TEXT    (default NULL)
--   p_advance_amount     NUMERIC (default 0)
--   p_advance_ledger_id  UUID    (default NULL)
--
-- Returns JSONB:
--   { receipt_voucher_id, voucher_number, total_applied, status, remaining }
--
-- Journal (receipt mode, all per the direction table in SETTLEMENT_MODULE.md):
--   Dr  bank_ledger_id   per bank line amount
--   Dr  tds_ledger_id    p_tds_amount     (if > 0)
--   Dr  advance_ledger_id p_advance_amount (if > 0)
--   Cr  party_ledger_id  total_applied    (sum of all Dr sides)

CREATE OR REPLACE FUNCTION pramaana.post_settlement_receipt(
    p_company_id         UUID,
    p_created_by         UUID,
    p_party_ledger_id    UUID,
    p_invoice_voucher_id UUID,
    p_bank_lines         JSONB,
    p_tds_amount         NUMERIC  DEFAULT 0,
    p_tds_ledger_id      UUID     DEFAULT NULL,
    p_tds_section_code   TEXT     DEFAULT NULL,
    p_advance_amount     NUMERIC  DEFAULT 0,
    p_advance_ledger_id  UUID     DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pramaana, registry, public
AS $$
DECLARE
    v_open_balance        NUMERIC(15,2);
    v_bank_total          NUMERIC(15,2) := 0;
    v_total_applied       NUMERIC(15,2);
    v_remaining           NUMERIC(15,2);
    v_settlement_status   TEXT;

    v_company_code        TEXT;
    v_vt_receipt_id       UUID;
    v_voucher_date        DATE;
    v_voucher_num         TEXT;
    v_voucher_id          UUID;

    v_tds_amount          NUMERIC(15,2);
    v_advance_amount      NUMERIC(15,2);
    v_advance_outstanding NUMERIC(15,2);

    v_line                JSONB;
    v_sort                INT := 0;
BEGIN
    -- ── Normalise optional amounts ────────────────────────────────────────────
    v_tds_amount     := COALESCE(p_tds_amount,     0);
    v_advance_amount := COALESCE(p_advance_amount, 0);

    -- ── Guard: bank lines must be present and have positive amounts ───────────
    IF p_bank_lines IS NULL OR jsonb_array_length(p_bank_lines) = 0 THEN
        RAISE EXCEPTION 'post_settlement_receipt: p_bank_lines is empty';
    END IF;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_bank_lines)
    LOOP
        IF (v_line->>'amount')::NUMERIC <= 0 THEN
            RAISE EXCEPTION 'post_settlement_receipt: bank line amount must be > 0 (got %)',
                v_line->>'amount';
        END IF;
        IF (v_line->>'receipt_date') IS NULL THEN
            RAISE EXCEPTION 'post_settlement_receipt: bank line missing receipt_date';
        END IF;
        v_bank_total := v_bank_total + (v_line->>'amount')::NUMERIC;
    END LOOP;

    v_total_applied := round(v_bank_total + v_tds_amount + v_advance_amount, 2);

    IF v_total_applied <= 0 THEN
        RAISE EXCEPTION 'post_settlement_receipt: total applied must be > 0 (got %)',
            v_total_applied;
    END IF;

    -- ── Guard: TDS / advance must have ledgers when amounts > 0 ──────────────
    IF v_tds_amount > 0 AND p_tds_ledger_id IS NULL THEN
        RAISE EXCEPTION 'post_settlement_receipt: p_tds_ledger_id required when p_tds_amount > 0';
    END IF;
    IF v_advance_amount > 0 AND p_advance_ledger_id IS NULL THEN
        RAISE EXCEPTION 'post_settlement_receipt: p_advance_ledger_id required when p_advance_amount > 0';
    END IF;

    -- ── Look up open balance via get_outstanding_invoices ────────────────────
    -- This works for both real SALE voucher IDs and the synthetic opening
    -- balance row (whose voucher_id = ledger UUID, per migration 080).
    SELECT outstanding INTO v_open_balance
    FROM   pramaana.get_outstanding_invoices(p_company_id, p_party_ledger_id)
    WHERE  voucher_id = p_invoice_voucher_id;

    IF NOT FOUND OR v_open_balance IS NULL THEN
        RAISE EXCEPTION
            'post_settlement_receipt: document % not found or already fully settled',
            p_invoice_voucher_id;
    END IF;

    -- ── Guard: do not over-apply (½ paise tolerance) ─────────────────────────
    IF v_total_applied > v_open_balance + 0.005 THEN
        RAISE EXCEPTION
            'post_settlement_receipt: total applied (%) exceeds open balance (%) for document %',
            v_total_applied, v_open_balance, p_invoice_voucher_id;
    END IF;

    -- ── Guard: advance recovery must not exceed party_config balance ──────────
    -- Row-locked to prevent concurrent over-recovery.
    IF v_advance_amount > 0 THEN
        SELECT advance_outstanding INTO v_advance_outstanding
        FROM   pramaana.party_config
        WHERE  company_id = p_company_id
          AND  ledger_id  = p_party_ledger_id
        FOR UPDATE;

        IF NOT FOUND OR v_advance_outstanding IS NULL THEN
            RAISE EXCEPTION
                'post_settlement_receipt: party_config not found for ledger % — cannot verify advance balance',
                p_party_ledger_id;
        END IF;

        IF v_advance_amount > v_advance_outstanding + 0.005 THEN
            RAISE EXCEPTION
                'post_settlement_receipt: advance recovery (%) exceeds advance_outstanding (%) for party %',
                v_advance_amount, v_advance_outstanding, p_party_ledger_id;
        END IF;
    END IF;

    -- ── Resolve company_code and RCPT voucher_type_id ────────────────────────
    SELECT code INTO v_company_code
    FROM   registry.companies WHERE id = p_company_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'post_settlement_receipt: company not found: %', p_company_id;
    END IF;

    SELECT id INTO v_vt_receipt_id
    FROM   pramaana.voucher_types WHERE nature = 'receipt' LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'post_settlement_receipt: receipt voucher_type row missing in pramaana.voucher_types';
    END IF;

    -- ── Voucher date = latest receipt_date across all bank lines ─────────────
    SELECT MAX((bl->>'receipt_date')::DATE) INTO v_voucher_date
    FROM   jsonb_array_elements(p_bank_lines) bl;

    -- ── Allocate voucher number (non-transactional sequence — gaps OK) ────────
    v_voucher_num := registry.next_fy_sequence(
        p_company_id, v_company_code, 'RCPT', v_voucher_date
    );

    -- ── Create voucher (draft) ────────────────────────────────────────────────
    INSERT INTO pramaana.vouchers (
        company_id, voucher_type_id, voucher_number, voucher_date,
        narration, amount, status, created_by
    )
    VALUES (
        p_company_id,
        v_vt_receipt_id,
        v_voucher_num,
        v_voucher_date,
        'Settlement receipt against ' || p_invoice_voucher_id::TEXT,
        v_total_applied,
        'draft',
        p_created_by
    )
    RETURNING id INTO v_voucher_id;

    -- ── Insert journal entries ────────────────────────────────────────────────
    -- Zone A: one Dr entry per bank line
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_bank_lines)
    LOOP
        v_sort := v_sort + 1;
        INSERT INTO pramaana.voucher_entries
            (voucher_id, ledger_id, entry_type, amount, sort_order)
        VALUES (
            v_voucher_id,
            (v_line->>'bank_ledger_id')::UUID,
            'Dr',
            round((v_line->>'amount')::NUMERIC, 2),
            v_sort
        );
    END LOOP;

    -- Zone B: TDS Dr (if any)
    IF v_tds_amount > 0 THEN
        v_sort := v_sort + 1;
        INSERT INTO pramaana.voucher_entries
            (voucher_id, ledger_id, entry_type, amount, sort_order)
        VALUES (
            v_voucher_id,
            p_tds_ledger_id,
            'Dr',
            round(v_tds_amount, 2),
            v_sort
        );
    END IF;

    -- Zone B: advance/deposit Dr (if any)
    IF v_advance_amount > 0 THEN
        v_sort := v_sort + 1;
        INSERT INTO pramaana.voucher_entries
            (voucher_id, ledger_id, entry_type, amount, sort_order)
        VALUES (
            v_voucher_id,
            p_advance_ledger_id,
            'Dr',
            round(v_advance_amount, 2),
            v_sort
        );
    END IF;

    -- Balancing Cr: party ledger
    v_sort := v_sort + 1;
    INSERT INTO pramaana.voucher_entries
        (voucher_id, ledger_id, entry_type, amount, sort_order)
    VALUES (
        v_voucher_id,
        p_party_ledger_id,
        'Cr',
        v_total_applied,
        v_sort
    );

    -- ── Post the voucher ──────────────────────────────────────────────────────
    UPDATE pramaana.vouchers
    SET    status = 'posted'
    WHERE  id = v_voucher_id;

    -- ── Write settlement_bank_lines ───────────────────────────────────────────
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_bank_lines)
    LOOP
        INSERT INTO pramaana.settlement_bank_lines
            (settlement_voucher_id, bank_ledger_id, receipt_date, amount, bank_reference)
        VALUES (
            v_voucher_id,
            (v_line->>'bank_ledger_id')::UUID,
            (v_line->>'receipt_date')::DATE,
            round((v_line->>'amount')::NUMERIC, 2),
            NULLIF(TRIM(COALESCE(v_line->>'bank_reference', '')), '')
        );
    END LOOP;

    -- ── Write invoice_settlements link ────────────────────────────────────────
    v_remaining := round(v_open_balance - v_total_applied, 2);
    v_settlement_status := CASE WHEN v_remaining <= 0.005 THEN 'settled' ELSE 'part_paid' END;

    INSERT INTO pramaana.invoice_settlements
        (company_id, invoice_voucher_id, settlement_voucher_id,
         amount_bank, amount_tds, amount_advance, settlement_status)
    VALUES (
        p_company_id,
        p_invoice_voucher_id,
        v_voucher_id,
        round(v_bank_total, 2),
        round(v_tds_amount, 2),
        round(v_advance_amount, 2),
        v_settlement_status
    );

    -- ── Decrement party_config.advance_outstanding ────────────────────────────
    IF v_advance_amount > 0 THEN
        UPDATE pramaana.party_config
        SET    advance_outstanding = GREATEST(0, advance_outstanding - v_advance_amount)
        WHERE  company_id = p_company_id
          AND  ledger_id  = p_party_ledger_id;
    END IF;

    -- ── Return result ─────────────────────────────────────────────────────────
    RETURN jsonb_build_object(
        'receipt_voucher_id', v_voucher_id,
        'voucher_number',     v_voucher_num,
        'total_applied',      v_total_applied,
        'status',             v_settlement_status,
        'remaining',          GREATEST(0, v_remaining)
    );

EXCEPTION
    WHEN OTHERS THEN
        RAISE;
END;
$$;

GRANT EXECUTE ON FUNCTION pramaana.post_settlement_receipt(
    UUID, UUID, UUID, UUID, JSONB, NUMERIC, UUID, TEXT, NUMERIC, UUID
) TO authenticated, service_role;
