-- ════════════════════════════════════════════════════════════════
-- 080_outstanding_invoices_add_opening_balance.sql
-- Fix: get_outstanding_invoices omits ledgers.opening_balance.
-- When a party ledger has opening_dr_cr='Dr' (they owe us money
-- carried from the prior period), that amount must appear as an
-- outstanding "invoice" so it can be settled against receipts.
-- We use the ledger's own UUID as a stable synthetic voucher_id
-- so that invoice_settlements can reference it normally.
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
        -- Real SALE vouchers
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

        UNION ALL

        -- Synthetic row for opening balance (carried from prior period)
        -- Uses the ledger UUID as the stable voucher_id so invoice_settlements
        -- can reference it.  Only included when opening is Dr (receivable).
        SELECT
            l.id                                      AS voucher_id,
            'Opening Balance'::TEXT                   AS voucher_number,
            (v_min.min_date - 1)::DATE                AS voucher_date,
            'Brought forward — opening receivable'::TEXT AS narration,
            l.opening_balance                         AS invoice_total
        FROM  pramaana.ledgers l
        CROSS JOIN LATERAL (
            SELECT COALESCE(MIN(v2.voucher_date), CURRENT_DATE) AS min_date
            FROM   pramaana.vouchers v2
            WHERE  v2.company_id = p_company_id
              AND  v2.status     = 'posted'
        ) v_min
        WHERE l.id            = p_party_ledger_id
          AND l.opening_dr_cr = 'Dr'
          AND l.opening_balance > 0
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
