-- ════════════════════════════════════════════════════════════════════════════
-- phase0_snapshot.sql — Pre-wipe row counts (READ-ONLY)
-- Run BEFORE phase1_wipe.sql.  Record the RFPL numbers — they must be
-- identical after the wipe.
-- ════════════════════════════════════════════════════════════════════════════

SELECT
    c.code                                          AS entity,
    (SELECT count(*) FROM pramaana.vouchers         v WHERE v.company_id = c.id) AS vouchers,
    (SELECT count(*) FROM pramaana.voucher_entries  e
       JOIN pramaana.vouchers v2 ON v2.id = e.voucher_id
      WHERE v2.company_id = c.id)                   AS entries,
    (SELECT count(*) FROM pramaana.ledgers           l WHERE l.company_id = c.id) AS ledgers,
    (SELECT count(*) FROM pramaana.recon_statements rs WHERE rs.company_id = c.id) AS recon_stmts,
    (SELECT count(*) FROM pramaana.recon_transactions rt
       JOIN pramaana.recon_statements rs2 ON rs2.id = rt.statement_id
      WHERE rs2.company_id = c.id)                  AS recon_txns,
    (SELECT count(*) FROM pramaana.recon_matches    rm WHERE rm.company_id = c.id) AS recon_matches
FROM registry.companies c
WHERE c.id IN (
    'b8beb440-df7f-48e8-a012-ac5750502eca',
    'bc455c94-0bcd-4d66-a040-d29ed880d22f'
)
ORDER BY c.code;
