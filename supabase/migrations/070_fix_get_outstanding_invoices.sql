-- ════════════════════════════════════════════════════════════════
-- 070b — Fix get_outstanding_invoices / get_outstanding_bills
--
-- Original 070 used v.voucher_type = 'SALE' (text) — the real
-- column is voucher_type_id UUID.  Corrected UUIDs confirmed from
-- pramaana.voucher_types:
--   SALE  8ca34992-7b19-4d44-b4fc-4a0ad7bdbc88
--   PURCH bf1c61a3-4b3d-4e50-8625-6d0a34ba128c
--   JNL   45f2422c-410d-4662-9bf3-d391a2a83b35
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pramaana.get_outstanding_invoices(
    p_company_id      UUID,
    p_party_ledger_id UUID
)
RETURNS TABLE (
    voucher_id     UUID,
    voucher_number TEXT,
    voucher_date   DATE,
    narration      TEXT,
    invoice_total  NUMERIC,
    amount_settled NUMERIC,
    outstanding    NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pramaana
AS $$
BEGIN
    RETURN QUERY
    WITH invoice_headers AS (
        SELECT
            v.id               AS voucher_id,
            v.voucher_number,
            v.voucher_date,
            v.narration,
            SUM(ve.amount)     AS invoice_total
        FROM  pramaana.vouchers        v
        JOIN  pramaana.voucher_entries ve ON ve.voucher_id = v.id
        WHERE v.company_id      = p_company_id
          AND v.voucher_type_id = '8ca34992-7b19-4d44-b4fc-4a0ad7bdbc88'
          AND v.status          = 'posted'
          AND ve.ledger_id      = p_party_ledger_id
          AND ve.entry_type     = 'Dr'
        GROUP BY v.id, v.voucher_number, v.voucher_date, v.narration
    ),
    settlement_agg AS (
        SELECT
            is2.invoice_voucher_id,
            SUM(is2.amount_total)                      AS amount_settled,
            bool_or(is2.settlement_status = 'settled') AS is_certified_settled
        FROM pramaana.invoice_settlements is2
        GROUP BY is2.invoice_voucher_id
    )
    SELECT
        ih.voucher_id,
        ih.voucher_number,
        ih.voucher_date,
        ih.narration,
        ih.invoice_total,
        COALESCE(sa.amount_settled, 0)                                  AS amount_settled,
        GREATEST(0, ih.invoice_total - COALESCE(sa.amount_settled, 0))  AS outstanding
    FROM  invoice_headers ih
    LEFT  JOIN settlement_agg sa ON sa.invoice_voucher_id = ih.voucher_id
    WHERE NOT COALESCE(sa.is_certified_settled, FALSE)
      AND GREATEST(0, ih.invoice_total - COALESCE(sa.amount_settled, 0)) > 0.005
    ORDER BY ih.voucher_date, ih.voucher_number;
END;
$$;

GRANT EXECUTE ON FUNCTION pramaana.get_outstanding_invoices(UUID, UUID)
    TO authenticated, service_role;


CREATE OR REPLACE FUNCTION pramaana.get_outstanding_bills(
    p_company_id      UUID,
    p_party_ledger_id UUID
)
RETURNS TABLE (
    voucher_id     UUID,
    voucher_number TEXT,
    voucher_date   DATE,
    narration      TEXT,
    bill_total     NUMERIC,
    amount_settled NUMERIC,
    outstanding    NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pramaana
AS $$
BEGIN
    RETURN QUERY
    WITH bill_headers AS (
        SELECT
            v.id               AS voucher_id,
            v.voucher_number,
            v.voucher_date,
            v.narration,
            SUM(ve.amount)     AS bill_total
        FROM  pramaana.vouchers        v
        JOIN  pramaana.voucher_entries ve ON ve.voucher_id = v.id
        WHERE v.company_id      = p_company_id
          AND v.voucher_type_id IN (
              'bf1c61a3-4b3d-4e50-8625-6d0a34ba128c',
              '45f2422c-410d-4662-9bf3-d391a2a83b35'
          )
          AND v.status          = 'posted'
          AND ve.ledger_id      = p_party_ledger_id
          AND ve.entry_type     = 'Cr'
        GROUP BY v.id, v.voucher_number, v.voucher_date, v.narration
    ),
    settlement_agg AS (
        SELECT
            is2.invoice_voucher_id,
            SUM(is2.amount_total)                      AS amount_settled,
            bool_or(is2.settlement_status = 'settled') AS is_certified_settled
        FROM pramaana.invoice_settlements is2
        GROUP BY is2.invoice_voucher_id
    )
    SELECT
        bh.voucher_id,
        bh.voucher_number,
        bh.voucher_date,
        bh.narration,
        bh.bill_total,
        COALESCE(sa.amount_settled, 0)                                      AS amount_settled,
        GREATEST(0, bh.bill_total - COALESCE(sa.amount_settled, 0))         AS outstanding
    FROM  bill_headers bh
    LEFT  JOIN settlement_agg sa ON sa.invoice_voucher_id = bh.voucher_id
    WHERE NOT COALESCE(sa.is_certified_settled, FALSE)
      AND GREATEST(0, bh.bill_total - COALESCE(sa.amount_settled, 0)) > 0.005
    ORDER BY bh.voucher_date, bh.voucher_number;
END;
$$;

GRANT EXECUTE ON FUNCTION pramaana.get_outstanding_bills(UUID, UUID)
    TO authenticated, service_role;
