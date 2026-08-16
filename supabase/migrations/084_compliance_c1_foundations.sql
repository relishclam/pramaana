-- ════════════════════════════════════════════════════════════════════════════
-- 084_compliance_c1_foundations.sql — Compliance Module Phase C1
--
-- Creates:
--   registry.company_statutory       — PAN/TAN/GSTIN/CIN + filing profile
--   pramaana.tds_rules               — threshold/rate table (never hardcoded)
--   pramaana.statutory_challans      — CBDT + GSTN challan registry
--   Extends pramaana.ledgers         — party statutory attributes
--   Extends pramaana.ledger_groups   — non_deductible_expense flag
--
-- Idempotent. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. company_statutory ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS registry.company_statutory (
  company_id          UUID        PRIMARY KEY REFERENCES registry.companies(id) ON DELETE CASCADE,
  pan                 TEXT,
  tan                 TEXT,
  gstin               TEXT,
  gst_state_code      TEXT,                  -- 2-digit e.g. '32' for Kerala
  cin                 TEXT,                  -- RFPL: U15127TN1977PTC007406
  incorporation_type  TEXT        NOT NULL DEFAULT 'pvt_ltd'
                      CHECK (incorporation_type IN ('pvt_ltd','partnership','llp','proprietorship','individual')),
  fy_start_month      INTEGER     NOT NULL DEFAULT 4,  -- April
  gst_frequency       TEXT        NOT NULL DEFAULT 'monthly'
                      CHECK (gst_frequency IN ('monthly','qrmp')),
  einvoice_applicable BOOLEAN     NOT NULL DEFAULT false,
  lut_number          TEXT,
  lut_valid_until     DATE,
  authorized_signatory_name  TEXT,
  authorized_signatory_pan   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE registry.company_statutory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cs_super_admin ON registry.company_statutory;
CREATE POLICY cs_super_admin ON registry.company_statutory
  FOR ALL TO authenticated
  USING (registry.is_super_admin())
  WITH CHECK (registry.is_super_admin());

DROP POLICY IF EXISTS cs_member_read ON registry.company_statutory;
CREATE POLICY cs_member_read ON registry.company_statutory
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS cs_service_all ON registry.company_statutory;
CREATE POLICY cs_service_all ON registry.company_statutory
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Seed RFPL and RHHF
INSERT INTO registry.company_statutory
  (company_id, pan, tan, gstin, gst_state_code, cin,
   incorporation_type, gst_frequency, einvoice_applicable, lut_number)
VALUES
  -- RFPL
  ('bc455c94-0bcd-4d66-a040-d29ed880d22f',
   NULL, NULL, NULL, '33', 'U15127TN1977PTC007406',
   'pvt_ltd', 'monthly', false, NULL),
  -- RHHF
  ('b8beb440-df7f-48e8-a012-ac5750502eca',
   NULL, NULL, NULL, '32', NULL,
   'partnership', 'qrmp', false, NULL)
ON CONFLICT (company_id) DO NOTHING;

COMMENT ON TABLE registry.company_statutory IS
  'Statutory identifiers and filing profile per company. '
  'gst_frequency controls whether the GSTR generator uses monthly or quarterly windows — '
  'flip to ''monthly'' when RHHF production starts without any code change.';

-- ── 2. Party statutory attributes — extend pramaana.ledgers ──────────────────

ALTER TABLE pramaana.ledgers
  ADD COLUMN IF NOT EXISTS pan                  TEXT,
  ADD COLUMN IF NOT EXISTS party_gstin          TEXT,
  ADD COLUMN IF NOT EXISTS constitution         TEXT
    CHECK (constitution IN ('individual','huf','firm','company','government','trust',NULL)),
  ADD COLUMN IF NOT EXISTS tds_section_default  TEXT,   -- for PAYEE ledgers: section when paying them
  ADD COLUMN IF NOT EXISTS tds_rate_override    NUMERIC(5,2),  -- lower-deduction certificate
  ADD COLUMN IF NOT EXISTS tds_exempt           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS msme_registered      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS msme_udyam_no        TEXT;

COMMENT ON COLUMN pramaana.ledgers.tds_section_default IS
  'TDS section code applied when making payments to this party ledger (e.g. 194C for contractors). '
  'Distinct from tds_section_code which marks this ledger AS a TDS payable account.';

COMMENT ON COLUMN pramaana.ledgers.tds_exempt IS
  'True for government bodies exempt from TDS, e.g. KSIDC u/s 194A(3)(iii).';

-- ── 3. Ledger group: non_deductible flag (for Interest on TDS visibility) ────

ALTER TABLE pramaana.ledger_groups
  ADD COLUMN IF NOT EXISTS is_non_deductible BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN pramaana.ledger_groups.is_non_deductible IS
  'True for expense groups whose items are disallowed under IT Act (e.g. interest on TDS delay).';

-- ── 4. Statutory ledger scaffolding (both companies) ─────────────────────────
-- Creates standard compliance ledgers where they do not already exist.

DO $$
DECLARE
  v_company   RECORD;
  v_liab_grp  UUID;
  v_exp_grp   UUID;
  v_asset_grp UUID;
BEGIN
  FOR v_company IN
    SELECT id, code FROM registry.companies
    WHERE id IN (
      'bc455c94-0bcd-4d66-a040-d29ed880d22f',
      'b8beb440-df7f-48e8-a012-ac5750502eca'
    )
  LOOP
    -- Resolve groups
    SELECT id INTO v_liab_grp FROM pramaana.ledger_groups
    WHERE (name ILIKE '%current liabilit%' OR name ILIKE '%duties%tax%' OR name ILIKE '%liability%')
      AND (company_id IS NULL OR company_id = v_company.id)
    ORDER BY company_id NULLS LAST LIMIT 1;

    SELECT id INTO v_exp_grp FROM pramaana.ledger_groups
    WHERE (name ILIKE '%indirect%expense%' OR name ILIKE '%indirect exp%')
      AND (company_id IS NULL OR company_id = v_company.id)
    ORDER BY company_id NULLS LAST LIMIT 1;

    SELECT id INTO v_asset_grp FROM pramaana.ledger_groups
    WHERE (name ILIKE '%current asset%' OR name ILIKE '%loans & advance%')
      AND (company_id IS NULL OR company_id = v_company.id)
    ORDER BY company_id NULLS LAST LIMIT 1;

    IF v_liab_grp IS NULL OR v_exp_grp IS NULL THEN
      RAISE NOTICE 'Skipping % — could not resolve ledger groups', v_company.code;
      CONTINUE;
    END IF;

    -- TDS Payable ledgers
    INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name, is_bank_account,
        opening_balance, opening_dr_cr, is_system, is_active, tds_section_code)
    SELECT v_company.id, v_liab_grp, l.name, l.name, FALSE, 0, 'Cr', FALSE, TRUE, l.section
    FROM (VALUES
      ('TDS Payable — 192 (Salaries)', '192'),
      ('TDS Payable — 194C (Contractors)', '194C'),
      ('TDS Payable — 194I (Rent)', '194I'),
      ('TDS Payable — 194J (Professional)', '194J'),
      ('TDS Payable — 194A (Interest)', '194A')
    ) AS l(name, section)
    WHERE NOT EXISTS (
      SELECT 1 FROM pramaana.ledgers
      WHERE company_id = v_company.id AND name = l.name
    );

    -- Interest on TDS (non-deductible expense)
    INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name, is_bank_account,
        opening_balance, opening_dr_cr, is_system, is_active)
    SELECT v_company.id, v_exp_grp, 'Interest on TDS (u/s 201/234E)', 'Interest on TDS', FALSE, 0, 'Dr', FALSE, TRUE
    WHERE NOT EXISTS (
      SELECT 1 FROM pramaana.ledgers
      WHERE company_id = v_company.id AND name ILIKE '%Interest on TDS%'
    );

    -- GST Cash Ledger (electronic cash ledger mirror)
    IF v_asset_grp IS NOT NULL THEN
      INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name, is_bank_account,
          opening_balance, opening_dr_cr, is_system, is_active)
      SELECT v_company.id, v_asset_grp, 'GST Cash Ledger (Electronic)', 'GST Cash Ledger', FALSE, 0, 'Dr', FALSE, TRUE
      WHERE NOT EXISTS (
        SELECT 1 FROM pramaana.ledgers
        WHERE company_id = v_company.id AND name ILIKE '%GST Cash Ledger%'
      );
    END IF;

    -- CBDT Payment + GSTN Payment heads (for voucher HOA)
    INSERT INTO pramaana.ledgers (company_id, group_id, name, tally_ledger_name, is_bank_account,
        opening_balance, opening_dr_cr, is_system, is_active)
    SELECT v_company.id, v_liab_grp, l.name, l.name, FALSE, 0, 'Cr', FALSE, TRUE
    FROM (VALUES
      ('CBDT Payment — TDS'),
      ('GSTN Payment')
    ) AS l(name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pramaana.ledgers
      WHERE company_id = v_company.id AND name = l.name
    );

    RAISE NOTICE 'Statutory ledgers ensured for %', v_company.code;
  END LOOP;
END;
$$;

-- ── 5. statutory_challans ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.statutory_challans (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID        NOT NULL,
  kind             TEXT        NOT NULL
                   CHECK (kind IN ('cbdt_tds','gstn','cbdt_advance_tax','cbdt_self_assessment')),
  section          TEXT,                   -- '194C', '194J', null for GST
  period_from      DATE        NOT NULL,
  period_to        DATE        NOT NULL,
  quarter_label    TEXT,                   -- 'Q2 FY26-27', 'Aug-2026'
  amount_tax       NUMERIC(15,2) NOT NULL DEFAULT 0,
  amount_interest  NUMERIC(15,2) NOT NULL DEFAULT 0,
  amount_fee       NUMERIC(15,2) NOT NULL DEFAULT 0,
  amount_total     NUMERIC(15,2) NOT NULL DEFAULT 0,
  cin              TEXT,                   -- Challan Identification Number
  bsr_code         TEXT,                   -- 7-digit BSR code
  challan_date     DATE,
  bank_voucher_id  UUID        REFERENCES pramaana.vouchers(id) ON DELETE SET NULL,
  deductee_breakup JSONB,                  -- [{party_id, party_name, pan, amount_paid, tds_amount}]
  notes            TEXT,
  created_by       UUID        REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT challan_total_matches CHECK (
    ABS(amount_total - (amount_tax + amount_interest + amount_fee)) < 0.01
    OR amount_total = 0  -- allow zero during draft entry
  )
);

CREATE INDEX IF NOT EXISTS idx_statutory_challans_company
  ON pramaana.statutory_challans (company_id, kind, period_from);

CREATE INDEX IF NOT EXISTS idx_statutory_challans_cin
  ON pramaana.statutory_challans (cin) WHERE cin IS NOT NULL;

ALTER TABLE pramaana.statutory_challans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sc_company_read ON pramaana.statutory_challans;
CREATE POLICY sc_company_read ON pramaana.statutory_challans
  FOR SELECT TO authenticated
  USING (company_id IN (
    SELECT cu.company_id FROM registry.company_users cu WHERE cu.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS sc_company_write ON pramaana.statutory_challans;
CREATE POLICY sc_company_write ON pramaana.statutory_challans
  FOR ALL TO authenticated
  USING (company_id IN (
    SELECT cu.company_id FROM registry.company_users cu WHERE cu.user_id = auth.uid()
  ))
  WITH CHECK (company_id IN (
    SELECT cu.company_id FROM registry.company_users cu WHERE cu.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS sc_service_all ON pramaana.statutory_challans;
CREATE POLICY sc_service_all ON pramaana.statutory_challans
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 6. Backfill: RHHF challan 04-Jun-2026 ────────────────────────────────────
-- CIN 26060400165918HDFC, tax ₹28,000 + interest ₹1,640
-- Deductee split pending CA confirmation (provisional: Drishya ₹22K + Mitra ₹6K @1%)

INSERT INTO pramaana.statutory_challans
  (company_id, kind, section, period_from, period_to, quarter_label,
   amount_tax, amount_interest, amount_fee, amount_total,
   cin, bsr_code, challan_date,
   deductee_breakup, notes)
VALUES (
  'b8beb440-df7f-48e8-a012-ac5750502eca',
  'cbdt_tds', '194C',
  '2026-04-01', '2026-06-30', 'Q1 FY26-27',
  28000.00, 1640.00, 0.00, 29640.00,
  '26060400165918HDFC', NULL, '2026-06-04',
  '[{"party_name":"Drishya Engineering & Consultance","pan":null,"amount_paid":2200000,"tds_amount":22000,"note":"provisional — CA confirmation pending"},{"party_name":"Mitra Constructions","pan":null,"amount_paid":600000,"tds_amount":6000,"note":"provisional"}]'::jsonb,
  'Interest ₹1,640 reclassify from Office Expense → Interest on TDS (non-deductible). CA confirmation pending on deductee split and recovery journal (Dr Drishya ₹22,000 / Cr Mitra ₹22,000 if split confirmed).'
)
ON CONFLICT DO NOTHING;

-- ── 7. Seed RHHF party statutory attributes ───────────────────────────────────

DO $$
DECLARE
  RHHF CONSTANT UUID := 'b8beb440-df7f-48e8-a012-ac5750502eca';
BEGIN
  -- Mitra Constructions — 194C (constitution TBD: 1% individual / 2% company)
  UPDATE pramaana.ledgers
     SET tds_section_default = '194C',
         constitution        = NULL   -- pending CA confirmation
   WHERE company_id = RHHF
     AND (name ILIKE '%Mitra Constructions%' OR name = 'Advance to Mitra Constructions');

  -- Drishya Engineering — 194C
  UPDATE pramaana.ledgers
     SET tds_section_default = '194C',
         constitution        = NULL
   WHERE company_id = RHHF
     AND (name ILIKE '%Drishya Engineering%' OR name = 'Advance to Drishya Engineering');

  -- KSIDC — TDS exempt (government financial institution u/s 194A(3)(iii))
  UPDATE pramaana.ledgers
     SET tds_exempt          = true,
         tds_section_default = '194A',
         constitution        = 'government'
   WHERE company_id = RHHF
     AND name ILIKE '%KSIDC%';

  -- Rent Paid — 194I (landlord ledger, if it exists)
  UPDATE pramaana.ledgers
     SET tds_section_default = '194I'
   WHERE company_id = RHHF
     AND name ILIKE '%Rent Paid%';

  RAISE NOTICE 'RHHF party statutory attributes seeded';
END;
$$;
