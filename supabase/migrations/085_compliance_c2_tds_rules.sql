-- ════════════════════════════════════════════════════════════════════════════
-- 085_compliance_c2_tds_rules.sql — TDS Rules Table (Phase C2)
--
-- Thresholds and rates stored in DB — never hardcoded.
-- effective_to IS NULL = currently applicable.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pramaana.tds_rules (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  section_code              TEXT        NOT NULL,
  description               TEXT        NOT NULL,
  -- Thresholds (NULL = no threshold, deduct from first rupee)
  single_payment_threshold  NUMERIC(15,2),   -- per-transaction threshold
  aggregate_fy_threshold    NUMERIC(15,2),   -- cumulative FY threshold
  -- Rates by constitution
  rate_individual           NUMERIC(5,2) NOT NULL,
  rate_huf                  NUMERIC(5,2) NOT NULL,
  rate_firm                 NUMERIC(5,2) NOT NULL,
  rate_company              NUMERIC(5,2) NOT NULL,
  rate_pan_missing          NUMERIC(5,2) NOT NULL DEFAULT 20.00,  -- u/s 206AA
  -- Effective period
  effective_from            DATE        NOT NULL,
  effective_to              DATE,
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tds_rules_section_period_uq
  ON pramaana.tds_rules (section_code, effective_from)
  WHERE effective_to IS NULL;

-- No RLS — reference data, read by all authenticated users
ALTER TABLE pramaana.tds_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tds_rules_read ON pramaana.tds_rules;
CREATE POLICY tds_rules_read ON pramaana.tds_rules
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS tds_rules_service ON pramaana.tds_rules;
CREATE POLICY tds_rules_service ON pramaana.tds_rules
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Seed: FY26-27 rates (Finance Act 2026 — update if budget changes) ────────

INSERT INTO pramaana.tds_rules
  (section_code, description,
   single_payment_threshold, aggregate_fy_threshold,
   rate_individual, rate_huf, rate_firm, rate_company,
   effective_from, notes)
VALUES
  ('192',  'Salary',
   NULL, NULL,
   0.00, 0.00, 0.00, 0.00,
   '2026-04-01',
   'Rate = per slab; computed outside this table. Zero here marks section as salary.'),

  ('194A', 'Interest other than interest on securities',
   50000.00, NULL,
   10.00, 10.00, 10.00, 10.00,
   '2026-04-01',
   '₹50,000 threshold for banks (resident). KSIDC = government body, tds_exempt=true on ledger.'),

  ('194C', 'Payments to contractors/sub-contractors',
   30000.00, 100000.00,
   1.00, 1.00, 2.00, 2.00,
   '2026-04-01',
   '1% for individual/HUF; 2% for firm/company. Threshold: ₹30K per transaction OR ₹1L aggregate in FY.'),

  ('194I', 'Rent of land, building or furniture',
   240000.00, NULL,
   10.00, 10.00, 10.00, 10.00,
   '2026-04-01',
   '₹2,40,000 annual threshold. Rate 10% for all constitutions.'),

  ('194J', 'Professional/technical fees',
   50000.00, NULL,
   10.00, 10.00, 10.00, 10.00,
   '2026-04-01',
   '₹50,000 threshold. Covers CA/audit fees, legal, consultancy.'),

  ('194H', 'Commission or brokerage',
   15000.00, NULL,
   5.00, 5.00, 5.00, 5.00,
   '2026-04-01',
   NULL),

  ('194Q', 'Purchase of goods',
   5000000.00, NULL,
   0.10, 0.10, 0.10, 0.10,
   '2026-04-01',
   'Applies only to buyer with turnover > ₹10Cr. ₹50L aggregate threshold.')

ON CONFLICT DO NOTHING;

-- ── cumulative_tds_tracker view (per FY, per payee, per section) ─────────────
-- Used by the TDS engine to check aggregate threshold before deciding to deduct.

CREATE OR REPLACE VIEW pramaana.v_tds_cumulative AS
SELECT
    vtd.company_id,
    vtd.deductee_entity_id,
    vtd.section_code,
    date_trunc('year', v.voucher_date + INTERVAL '9 months')::date  AS fy_start,
    -- FY key: Apr 1 of the FY year (vouchers in Apr-Mar map to same FY)
    SUM(vtd.gross_amount)  AS cumulative_gross,
    SUM(vtd.tds_amount)    AS cumulative_tds,
    count(*)               AS deduction_count
FROM pramaana.voucher_tds_deductions vtd
JOIN pramaana.vouchers v ON v.id = vtd.voucher_id
WHERE v.status = 'posted'
GROUP BY vtd.company_id, vtd.deductee_entity_id, vtd.section_code,
         date_trunc('year', v.voucher_date + INTERVAL '9 months')::date;

COMMENT ON VIEW pramaana.v_tds_cumulative IS
  'Cumulative gross paid and TDS deducted per company/payee/section/FY. '
  'Used to evaluate whether aggregate thresholds (194C ₹1L etc.) have been crossed.';
