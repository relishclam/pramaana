-- ════════════════════════════════════════════════════════════════
-- 082_foodstream_receipt_vouchers.sql
-- 9 historical advance receipt vouchers — FoodStream Ltd (RFPL)
-- Accounting: Dr Bank / Cr FoodStream Ltd (Sundry Debtors)
-- No income recognised — pure advance receipts.
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE
    v_rfpl       UUID := 'bc455c94-0bcd-4d66-a040-d29ed880d22f';
    v_vt_rcpt    UUID := 'ca7d4bb8-ad82-4d1c-a3ef-19254e0135fe';
    v_entity_fs  UUID;
    v_ledger_fs  UUID;
    v_canara     UUID;
    v_federal    UUID;
    v_creator    UUID;
    v_vid        UUID;
BEGIN
    -- ── Resolve UUIDs live from DB ────────────────────────────────────────────
    SELECT id INTO v_entity_fs
        FROM registry.entities WHERE display_name ILIKE '%FoodStream%' LIMIT 1;

    SELECT id INTO v_ledger_fs
        FROM pramaana.ledgers
        WHERE company_id = v_rfpl AND name ILIKE '%FoodStream%' LIMIT 1;

    SELECT id INTO v_canara
        FROM pramaana.ledgers
        WHERE company_id = v_rfpl AND name = 'Canara Bank' LIMIT 1;

    SELECT id INTO v_federal
        FROM pramaana.ledgers
        WHERE company_id = v_rfpl AND name = 'Federal Bank' LIMIT 1;

    SELECT id INTO v_creator
        FROM registry.profiles WHERE is_super_admin ORDER BY created_at LIMIT 1;

    IF v_entity_fs IS NULL THEN RAISE EXCEPTION 'FoodStream entity not found in registry.entities'; END IF;
    IF v_ledger_fs IS NULL THEN RAISE EXCEPTION 'FoodStream ledger not found in pramaana.ledgers'; END IF;
    IF v_canara    IS NULL THEN RAISE EXCEPTION 'Canara Bank ledger not found'; END IF;
    IF v_federal   IS NULL THEN RAISE EXCEPTION 'Federal Bank ledger not found'; END IF;

    -- ── Helper macro: create draft → entries → post ───────────────────────────
    -- Repeated 9 times, one per voucher.

    -- 1. 2026-04-02 · ₹1,79,948.73 · Canara · SCBLH26092001186
    INSERT INTO pramaana.vouchers
        (company_id, voucher_type_id, voucher_number, voucher_date,
         narration, amount, status, entity_id, bank_ledger_id,
         payment_mode, utr_number, source, created_by)
    VALUES
        (v_rfpl, v_vt_rcpt, 'RCPT/FS/2627/0001', '2026-04-02',
         'FoodStream advance — Standard Chartered NEFT FEMA compliance',
         179948.73, 'draft', v_entity_fs, v_canara,
         'Account Transfer', 'SCBLH26092001186', 'manual', v_creator)
    RETURNING id INTO v_vid;

    INSERT INTO pramaana.voucher_entries (voucher_id, ledger_id, entry_type, amount, sort_order)
    VALUES (v_vid, v_canara,    'Dr', 179948.73, 1),
           (v_vid, v_ledger_fs, 'Cr', 179948.73, 2);

    UPDATE pramaana.vouchers SET status = 'posted' WHERE id = v_vid;

    -- 2. 2026-04-22 · ₹1,18,521.32 · Federal · 611244856697
    INSERT INTO pramaana.vouchers
        (company_id, voucher_type_id, voucher_number, voucher_date,
         narration, amount, status, entity_id, bank_ledger_id,
         payment_mode, utr_number, source, created_by)
    VALUES
        (v_rfpl, v_vt_rcpt, 'RCPT/FS/2627/0002', '2026-04-22',
         'FoodStream advance — Airwallex HK via DBS',
         118521.32, 'draft', v_entity_fs, v_federal,
         'Account Transfer', '611244856697', 'manual', v_creator)
    RETURNING id INTO v_vid;

    INSERT INTO pramaana.voucher_entries (voucher_id, ledger_id, entry_type, amount, sort_order)
    VALUES (v_vid, v_federal,   'Dr', 118521.32, 1),
           (v_vid, v_ledger_fs, 'Cr', 118521.32, 2);

    UPDATE pramaana.vouchers SET status = 'posted' WHERE id = v_vid;

    -- 3. 2026-04-28 · ₹1,19,290.47 · Federal · 611850253243
    INSERT INTO pramaana.vouchers
        (company_id, voucher_type_id, voucher_number, voucher_date,
         narration, amount, status, entity_id, bank_ledger_id,
         payment_mode, utr_number, source, created_by)
    VALUES
        (v_rfpl, v_vt_rcpt, 'RCPT/FS/2627/0003', '2026-04-28',
         'FoodStream advance — Airwallex HK via DBS',
         119290.47, 'draft', v_entity_fs, v_federal,
         'Account Transfer', '611850253243', 'manual', v_creator)
    RETURNING id INTO v_vid;

    INSERT INTO pramaana.voucher_entries (voucher_id, ledger_id, entry_type, amount, sort_order)
    VALUES (v_vid, v_federal,   'Dr', 119290.47, 1),
           (v_vid, v_ledger_fs, 'Cr', 119290.47, 2);

    UPDATE pramaana.vouchers SET status = 'posted' WHERE id = v_vid;

    -- 4. 2026-05-16 · ₹60,355.76 · Federal · 613666908965
    INSERT INTO pramaana.vouchers
        (company_id, voucher_type_id, voucher_number, voucher_date,
         narration, amount, status, entity_id, bank_ledger_id,
         payment_mode, utr_number, source, created_by)
    VALUES
        (v_rfpl, v_vt_rcpt, 'RCPT/FS/2627/0004', '2026-05-16',
         'FoodStream advance — Airwallex HK via DBS',
         60355.76, 'draft', v_entity_fs, v_federal,
         'Account Transfer', '613666908965', 'manual', v_creator)
    RETURNING id INTO v_vid;

    INSERT INTO pramaana.voucher_entries (voucher_id, ledger_id, entry_type, amount, sort_order)
    VALUES (v_vid, v_federal,   'Dr', 60355.76, 1),
           (v_vid, v_ledger_fs, 'Cr', 60355.76, 2);

    UPDATE pramaana.vouchers SET status = 'posted' WHERE id = v_vid;

    -- 5. 2026-05-27 · ₹36,251.87 · Federal · SCBLH26147001935
    INSERT INTO pramaana.vouchers
        (company_id, voucher_type_id, voucher_number, voucher_date,
         narration, amount, status, entity_id, bank_ledger_id,
         payment_mode, utr_number, source, created_by)
    VALUES
        (v_rfpl, v_vt_rcpt, 'RCPT/FS/2627/0005', '2026-05-27',
         'FoodStream advance — Standard Chartered',
         36251.87, 'draft', v_entity_fs, v_federal,
         'Account Transfer', 'SCBLH26147001935', 'manual', v_creator)
    RETURNING id INTO v_vid;

    INSERT INTO pramaana.voucher_entries (voucher_id, ledger_id, entry_type, amount, sort_order)
    VALUES (v_vid, v_federal,   'Dr', 36251.87, 1),
           (v_vid, v_ledger_fs, 'Cr', 36251.87, 2);

    UPDATE pramaana.vouchers SET status = 'posted' WHERE id = v_vid;

    -- 6. 2026-06-02 · ₹83,742.31 · Federal · SCBLH26153000610
    INSERT INTO pramaana.vouchers
        (company_id, voucher_type_id, voucher_number, voucher_date,
         narration, amount, status, entity_id, bank_ledger_id,
         payment_mode, utr_number, source, created_by)
    VALUES
        (v_rfpl, v_vt_rcpt, 'RCPT/FS/2627/0006', '2026-06-02',
         'FoodStream advance — Standard Chartered',
         83742.31, 'draft', v_entity_fs, v_federal,
         'Account Transfer', 'SCBLH26153000610', 'manual', v_creator)
    RETURNING id INTO v_vid;

    INSERT INTO pramaana.voucher_entries (voucher_id, ledger_id, entry_type, amount, sort_order)
    VALUES (v_vid, v_federal,   'Dr', 83742.31, 1),
           (v_vid, v_ledger_fs, 'Cr', 83742.31, 2);

    UPDATE pramaana.vouchers SET status = 'posted' WHERE id = v_vid;

    -- 7. 2026-06-23 · ₹59,779.07 · Federal · 617435651597
    INSERT INTO pramaana.vouchers
        (company_id, voucher_type_id, voucher_number, voucher_date,
         narration, amount, status, entity_id, bank_ledger_id,
         payment_mode, utr_number, source, created_by)
    VALUES
        (v_rfpl, v_vt_rcpt, 'RCPT/FS/2627/0007', '2026-06-23',
         'FoodStream advance — Airwallex HK via DBS',
         59779.07, 'draft', v_entity_fs, v_federal,
         'Account Transfer', '617435651597', 'manual', v_creator)
    RETURNING id INTO v_vid;

    INSERT INTO pramaana.voucher_entries (voucher_id, ledger_id, entry_type, amount, sort_order)
    VALUES (v_vid, v_federal,   'Dr', 59779.07, 1),
           (v_vid, v_ledger_fs, 'Cr', 59779.07, 2);

    UPDATE pramaana.vouchers SET status = 'posted' WHERE id = v_vid;

    -- 8. 2026-06-29 · ₹23,826.18 · Federal · SCBLH26180002968
    INSERT INTO pramaana.vouchers
        (company_id, voucher_type_id, voucher_number, voucher_date,
         narration, amount, status, entity_id, bank_ledger_id,
         payment_mode, utr_number, source, created_by)
    VALUES
        (v_rfpl, v_vt_rcpt, 'RCPT/FS/2627/0008', '2026-06-29',
         'FoodStream advance — Standard Chartered',
         23826.18, 'draft', v_entity_fs, v_federal,
         'Account Transfer', 'SCBLH26180002968', 'manual', v_creator)
    RETURNING id INTO v_vid;

    INSERT INTO pramaana.voucher_entries (voucher_id, ledger_id, entry_type, amount, sort_order)
    VALUES (v_vid, v_federal,   'Dr', 23826.18, 1),
           (v_vid, v_ledger_fs, 'Cr', 23826.18, 2);

    UPDATE pramaana.vouchers SET status = 'posted' WHERE id = v_vid;

    -- 9. 2026-07-03 · ₹21,657.67 · Federal · HSBCN18462957084
    INSERT INTO pramaana.vouchers
        (company_id, voucher_type_id, voucher_number, voucher_date,
         narration, amount, status, entity_id, bank_ledger_id,
         payment_mode, utr_number, source, created_by)
    VALUES
        (v_rfpl, v_vt_rcpt, 'RCPT/FS/2627/0009', '2026-07-03',
         'FoodStream advance — HSBC Hong Kong',
         21657.67, 'draft', v_entity_fs, v_federal,
         'Account Transfer', 'HSBCN18462957084', 'manual', v_creator)
    RETURNING id INTO v_vid;

    INSERT INTO pramaana.voucher_entries (voucher_id, ledger_id, entry_type, amount, sort_order)
    VALUES (v_vid, v_federal,   'Dr', 21657.67, 1),
           (v_vid, v_ledger_fs, 'Cr', 21657.67, 2);

    UPDATE pramaana.vouchers SET status = 'posted' WHERE id = v_vid;

    RAISE NOTICE 'Done — 9 FoodStream receipt vouchers posted. Total = 703373.38';
END;
$$;

-- ── Verification 1: all 9 vouchers ───────────────────────────────────────────
SELECT voucher_number, voucher_date, amount, status, utr_number
FROM   pramaana.vouchers
WHERE  company_id    = 'bc455c94-0bcd-4d66-a040-d29ed880d22f'
  AND  voucher_number LIKE 'RCPT/FS/2627/%'
ORDER  BY voucher_date;

-- ── Verification 2: trial balance still zero ─────────────────────────────────
SELECT
    SUM(CASE WHEN ve.entry_type = 'Dr' THEN ve.amount ELSE -ve.amount END) AS net
FROM   pramaana.voucher_entries ve
JOIN   pramaana.vouchers        v  ON v.id = ve.voucher_id
WHERE  v.company_id = 'bc455c94-0bcd-4d66-a040-d29ed880d22f'
  AND  v.status     = 'posted';
