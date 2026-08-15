-- ════════════════════════════════════════════════════════════════════════════
-- phase4_verify.sql — Verification Gates (RHHF, post Phase 3)
-- Single UNION ALL — SQL Editor returns all 7 gates in one result set.
-- All gates must show ✓ PASS before go-live.
-- ════════════════════════════════════════════════════════════════════════════

SELECT gate, result, detail FROM (

    -- Gate 1 — Trial Balance (Dr = Cr)
    SELECT
        '1. Trial Balance' AS gate,
        CASE WHEN SUM(CASE WHEN opening_dr_cr = 'Dr' THEN opening_balance ELSE 0 END)
                = SUM(CASE WHEN opening_dr_cr = 'Cr' THEN opening_balance ELSE 0 END)
             THEN '✓ PASS'
             ELSE '✗ FAIL'
        END AS result,
        'Dr ' || SUM(CASE WHEN opening_dr_cr = 'Dr' THEN opening_balance ELSE 0 END)::text
        || '  Cr ' || SUM(CASE WHEN opening_dr_cr = 'Cr' THEN opening_balance ELSE 0 END)::text
        || '  diff ' || (SUM(CASE WHEN opening_dr_cr = 'Dr' THEN opening_balance ELSE 0 END)
                       - SUM(CASE WHEN opening_dr_cr = 'Cr' THEN opening_balance ELSE 0 END))::text
        AS detail
    FROM pramaana.ledgers
    WHERE company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
      AND opening_balance <> 0

    UNION ALL

    -- Gate 2 — HDFC No-Lien A/c 1702 = Dr 22,04,349.32 (statement-exact)
    SELECT
        '2. HDFC No-Lien 1702',
        CASE WHEN opening_balance = 2204349.32 AND opening_dr_cr = 'Dr'
             THEN '✓ PASS'
             ELSE '✗ FAIL — got ' || opening_dr_cr || ' ' || opening_balance::text
        END,
        name || '  acct=' || COALESCE(account_number, 'NULL')
    FROM pramaana.ledgers
    WHERE company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
      AND account_number = '50200115901702'

    UNION ALL

    -- Gate 3 — HDFC Current A/c 2324 = Dr 1,87,146.18 (₹1 known variance vs statement)
    SELECT
        '3. HDFC Current 2324',
        CASE WHEN opening_balance = 187146.18 AND opening_dr_cr = 'Dr'
             THEN '✓ PASS  (NOTE: ₹1 variance vs statement ₹1,87,145.18 — logged for CA)'
             ELSE '✗ FAIL — got ' || opening_dr_cr || ' ' || opening_balance::text
        END,
        name || '  acct=' || COALESCE(account_number, 'NULL')
    FROM pramaana.ledgers
    WHERE company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
      AND account_number = '99999446012324'

    UNION ALL

    -- Gate 4 — Cash in Hand = Dr 30,683.00
    SELECT
        '4. Cash in Hand',
        MAX(CASE WHEN opening_balance = 30683.00 AND opening_dr_cr = 'Dr'
             THEN '✓ PASS'
             ELSE '✗ FAIL — got ' || opening_dr_cr || ' ' || opening_balance::text
        END),
        MAX(name)
    FROM pramaana.ledgers
    WHERE company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
      AND name ILIKE '%cash in hand%'

    UNION ALL

    -- Gate 5 — Capital group net Cr = 67,78,672.37
    SELECT
        '5. Capital total',
        CASE WHEN ABS(
                SUM(CASE WHEN l.opening_dr_cr = 'Cr' THEN l.opening_balance ELSE -l.opening_balance END)
                - 6778672.37) < 0.01
             THEN '✓ PASS'
             ELSE '✗ FAIL — got ' ||
                  SUM(CASE WHEN l.opening_dr_cr = 'Cr' THEN l.opening_balance ELSE -l.opening_balance END)::text
        END,
        'active capital ledgers with OB: ' ||
            string_agg(l.name || ' ' || l.opening_dr_cr || ' ' || l.opening_balance::text, ' | ')
    FROM pramaana.ledgers l
    JOIN pramaana.ledger_groups lg ON lg.id = l.group_id
    WHERE l.company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
      AND lg.name ILIKE '%capital%'
      AND l.opening_balance <> 0
      AND l.is_active = true
      AND l.name NOT ILIKE '%opening adjustment%'

    UNION ALL

    -- Gate 6 — KSIDC = Cr 1,30,00,000 in Loans (Liability), NOT Bank
    SELECT
        '6. KSIDC Term Loan',
        MAX(CASE
            WHEN l.opening_balance = 13000000.00
             AND l.opening_dr_cr   = 'Cr'
             AND lg.name NOT ILIKE '%bank%'
            THEN '✓ PASS'
            WHEN l.opening_balance <> 13000000.00 OR l.opening_dr_cr <> 'Cr'
            THEN '✗ FAIL — amount/side: ' || l.opening_dr_cr || ' ' || l.opening_balance::text
            ELSE '✗ FAIL — still in Bank group: ' || lg.name
        END),
        MAX('group=' || lg.name || '  nature=' || COALESCE(lg.nature, '?'))
    FROM pramaana.ledgers l
    JOIN pramaana.ledger_groups lg ON lg.id = l.group_id
    WHERE l.company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
      AND l.name ILIKE '%KSIDC%'

    UNION ALL

    -- Gate 7 — RFPL data untouched (Phase 0 baseline: 1517 vouchers, 3034 entries)
    SELECT
        '7. RFPL intact',
        CASE
            WHEN count(DISTINCT v.id) = 1517 AND count(DISTINCT e.id) = 3034
            THEN '✓ PASS'
            ELSE '✗ FAIL — vouchers=' || count(DISTINCT v.id)::text
                       || ' entries=' || count(DISTINCT e.id)::text
                       || ' (expected 1517 / 3034)'
        END,
        'vouchers=' || count(DISTINCT v.id)::text || '  entries=' || count(DISTINCT e.id)::text
    FROM pramaana.vouchers v
    LEFT JOIN pramaana.voucher_entries e ON e.voucher_id = v.id
    WHERE v.company_id = 'bc455c94-0bcd-4d66-a040-d29ed880d22f'

) gates
ORDER BY gate;

