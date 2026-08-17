-- ════════════════════════════════════════════════════════════════════════════
-- RHHF TDS Audit — run in Supabase SQL Editor
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Check if TDS tables exist ─────────────────────────────────────────────
SELECT
    table_name,
    'EXISTS' AS status
FROM information_schema.tables
WHERE table_schema = 'pramaana'
  AND table_name IN ('voucher_tds_deductions')

UNION ALL

SELECT
    'voucher_tds_deductions' AS table_name,
    'MISSING' AS status
WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'pramaana' AND table_name = 'voucher_tds_deductions'
);

-- ── 2. TDS-applicable ledgers for RHHF ───────────────────────────────────────
SELECT
    name,
    tds_section_code,
    tds_rate,
    is_tds_applicable,
    is_active
FROM pramaana.ledgers
WHERE company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
  AND is_tds_applicable = true
ORDER BY name;

-- ── 3. All RHHF ledgers with tds_section_code set (even if flag not set) ─────
SELECT
    name,
    tds_section_code,
    tds_rate,
    is_tds_applicable
FROM pramaana.ledgers
WHERE company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
  AND tds_section_code IS NOT NULL
ORDER BY name;

-- ── 4. TDS deductions recorded (if table exists) ─────────────────────────────
SELECT
    vtd.id,
    vtd.section_code,
    vtd.tds_amount,
    vtd.gross_amount,
    vtd.tds_rate_applied,
    vtd.deductee_name,
    vtd.deductee_pan,
    vtd.challan_date,
    vtd.challan_bsr_code,
    vtd.challan_serial,
    v.voucher_number,
    v.voucher_date,
    v.narration
FROM pramaana.voucher_tds_deductions vtd
JOIN pramaana.vouchers v ON v.id = vtd.voucher_id
WHERE vtd.company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
ORDER BY v.voucher_date DESC;

-- ── 5. Vouchers with TDS flagged but no deduction row ─────────────────────────
-- (vouchers that have tds_amount > 0 on their entries but no deduction recorded)
SELECT
    v.voucher_number,
    v.voucher_date,
    v.narration,
    SUM(ve.amount) AS total_amount
FROM pramaana.vouchers v
JOIN pramaana.voucher_entries ve ON ve.voucher_id = v.id
JOIN pramaana.ledgers l ON l.id = ve.ledger_id
WHERE v.company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
  AND v.status = 'posted'
  AND l.is_tds_applicable = true
  AND NOT EXISTS (
      SELECT 1 FROM pramaana.voucher_tds_deductions vtd
      WHERE vtd.voucher_id = v.id
  )
GROUP BY v.voucher_number, v.voucher_date, v.narration
ORDER BY v.voucher_date DESC;
