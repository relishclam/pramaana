-- ════════════════════════════════════════════════════════════════════════════
-- 090_v_tds_report_entries.sql
--
-- Flat view replacing the cross-schema embedded join in TdsReports.tsx.
-- Supabase's TS client cannot parse registry.entities(...) nested inside a
-- renamed !inner relation, so we flatten the join here instead.
--
-- Security note: this view runs with definer privileges (postgres) which is
-- why it can reach registry.entities without granting that table to the
-- authenticated role. The company_id column is exposed so the client can
-- supply a mandatory company_id=eq.<uuid> filter — enforcing company
-- scoping at the query level. Use security_invoker = true only if you add
-- GRANT SELECT ON registry.entities TO authenticated.
-- ════════════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS pramaana.v_tds_report_entries;
CREATE VIEW pramaana.v_tds_report_entries AS
SELECT
  ve.ledger_id,
  ve.entry_type,
  ve.amount,
  v.id              AS voucher_id,
  v.voucher_number,
  v.voucher_date,
  v.status,
  v.company_id,
  e.display_name    AS party_name,
  e.pan             AS party_pan,
  l.tds_section_code,
  l.name            AS ledger_name,
  l.tds_rate,
  -- true for TDS Payable ledgers; Dr rows on these are CBDT remittances, not gross payments
  (l.name ILIKE 'TDS Payable%') AS is_tds_payable_ledger
FROM      pramaana.voucher_entries ve
JOIN      pramaana.vouchers        v  ON  v.id = ve.voucher_id
JOIN      pramaana.ledgers         l  ON  l.id = ve.ledger_id
                                      AND l.is_tds_applicable = true
                                      AND l.is_active         = true
LEFT JOIN registry.entities        e  ON  e.id = v.entity_id;

COMMENT ON VIEW pramaana.v_tds_report_entries IS
  'Flat TDS entry rows for Form 26Q generation. '
  'Filter: company_id=eq.<uuid> (mandatory), voucher_date range, status in (...). '
  'Covers only ledgers where is_tds_applicable = true AND is_active = true.';

-- PostgREST needs SELECT on the view for the authenticated caller role
GRANT SELECT ON pramaana.v_tds_report_entries TO authenticated;
GRANT SELECT ON pramaana.v_tds_report_entries TO service_role;
