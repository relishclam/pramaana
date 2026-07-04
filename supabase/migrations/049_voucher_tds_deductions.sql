-- ── TDS Per-Transaction Deductions — Migration 049 ───────────────────────────
-- Purpose: Capture the actual TDS deducted per voucher per deductee, plus
--          the challan reference when that TDS is deposited to the government.
--          This is the data Form 26Q requires that cannot be reconstructed
--          from voucher_entries alone.
--
-- Relationship to Migration 048:
--   048 tags WHICH ledger/party is TDS-applicable and under which section.
--   049 records WHAT was actually withheld on a specific voucher, from whom,
--   at what rate (which may differ from the standard rate if the deductee holds
--   a lower-deduction certificate), and when the TDS was deposited to the govt.
--
-- Workflow:
--   1. Accounts creates a Payment voucher for ₹1,00,000 to a contractor.
--      TDS @ 1% = ₹1,000 withheld. Net paid = ₹99,000.
--      The voucher_entries record: Dr Contractor ₹1,00,000 / Cr TDS Payable ₹1,000
--      / Cr Bank ₹99,000.
--
--   2. Accounts inserts a row here with:
--      voucher_id = the payment voucher
--      deductee_entity_id = contractor's entity_id
--      section_code = '194C'
--      gross_amount = 1,00,000
--      tds_amount = 1,000
--      tds_rate_applied = 1.00 (or 0.75 if Sec 206AB applies)
--
--   3. When TDS is deposited to the government (usually by the 7th of next month):
--      challan_bsr_code, challan_date, challan_serial are filled in.
--      The row is now complete for Form 26Q.
--
-- TDS Reports page queries this table. If a row is missing (deduction not
-- recorded), the report shows it as "unrecorded TDS" and flags it.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.voucher_tds_deductions (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id           UUID        NOT NULL REFERENCES pramaana.vouchers(id) ON DELETE CASCADE,
  company_id           UUID        NOT NULL,   -- denormalised for RLS / company scope
  deductee_entity_id   UUID,                   -- registry.entities.id; nullable if party not in registry
  deductee_name        TEXT        NOT NULL,   -- captured at deduction time (denormalised)
  deductee_pan         TEXT,                   -- captured at deduction time; NULL if not yet available
  section_code         TEXT        NOT NULL,   -- e.g. '194C', '194J' — matches ledger.tds_section_code
  gross_amount         NUMERIC(15,2) NOT NULL, -- full invoice/payment amount before TDS
  tds_amount           NUMERIC(15,2) NOT NULL, -- actual amount withheld
  tds_rate_applied     NUMERIC(5,2)  NOT NULL, -- effective rate (gross / tds × 100)
  -- Challan details — filled after TDS is deposited to government
  challan_bsr_code     TEXT,                   -- 7-digit BSR code of bank branch
  challan_date         DATE,                   -- date TDS deposited to govt
  challan_serial       TEXT,                   -- challan identification number
  -- Audit
  recorded_by          UUID        NOT NULL REFERENCES auth.users(id),
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                TEXT,
  -- Constraints
  CONSTRAINT tds_amount_positive     CHECK (tds_amount > 0),
  CONSTRAINT gross_amount_positive   CHECK (gross_amount > 0),
  CONSTRAINT tds_leq_gross           CHECK (tds_amount <= gross_amount),
  CONSTRAINT section_code_format     CHECK (section_code ~ '^[0-9]{2,3}[A-Z]?[A-Z]?$')
);

CREATE INDEX IF NOT EXISTS idx_voucher_tds_company     ON pramaana.voucher_tds_deductions (company_id);
CREATE INDEX IF NOT EXISTS idx_voucher_tds_voucher     ON pramaana.voucher_tds_deductions (voucher_id);
CREATE INDEX IF NOT EXISTS idx_voucher_tds_challan     ON pramaana.voucher_tds_deductions (company_id, challan_date)
  WHERE challan_date IS NOT NULL;

ALTER TABLE pramaana.voucher_tds_deductions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tds_deductions_read ON pramaana.voucher_tds_deductions
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY tds_deductions_write ON pramaana.voucher_tds_deductions
  FOR ALL TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'accounts', 'super_admin')
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM registry.company_users
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'accounts', 'super_admin')
    )
  );

COMMENT ON TABLE pramaana.voucher_tds_deductions IS
  'Per-voucher TDS deduction records. One row per payment where TDS was withheld. '
  'Challan columns are filled when TDS is deposited to the government. '
  'This table is the source of truth for Form 26Q quarterly returns.';

COMMENT ON COLUMN pramaana.voucher_tds_deductions.deductee_pan IS
  'PAN captured at deduction time. May differ from current entity PAN if '
  'the entity updated their PAN after the deduction was made.';

COMMENT ON COLUMN pramaana.voucher_tds_deductions.challan_bsr_code IS
  '7-digit BSR code of the bank branch where TDS was deposited. '
  'Required for Form 26Q. Obtained from the bank challan counterfoil.';

-- ── Unique challan index ──────────────────────────────────────────────────────
-- A single TDS challan deposit typically covers multiple deductees in one
-- banking transaction (one challan, multiple Annexure rows in Form 26Q).
-- The index is therefore scoped to (challan, voucher_id) not just (challan):
--   → Same challan across DIFFERENT vouchers/deductees: ALLOWED (batch deposit)
--   → Same challan against the SAME voucher twice: BLOCKED (data-entry duplicate)
-- Partial (WHERE all three challan columns NOT NULL) so rows without challan
-- details yet don't collide.

CREATE UNIQUE INDEX IF NOT EXISTS idx_tds_challan_unique
  ON pramaana.voucher_tds_deductions (challan_bsr_code, challan_serial, challan_date, voucher_id)
  WHERE challan_bsr_code IS NOT NULL
    AND challan_serial  IS NOT NULL
    AND challan_date    IS NOT NULL;

-- ── Protect challan-complete TDS rows from parent voucher deletion ────────────
-- Once TDS has been deposited to the government (challan_date IS NOT NULL),
-- the deduction record is an independent real-world fact. Deleting the parent
-- voucher via ON DELETE CASCADE would silently destroy government-filing evidence.
--
-- This trigger blocks DELETE of a voucher that has any TDS deduction row
-- with challan_date set — mirroring the same "immutable after real-world
-- terminal event" pattern used for posted vouchers and period locks.
--
-- The accounts team must explicitly clear challan details (or contact the CA)
-- before a voucher with deposited TDS can be removed.

CREATE OR REPLACE FUNCTION pramaana.fn_protect_challan_complete_tds()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pramaana.voucher_tds_deductions
    WHERE  voucher_id  = OLD.id
      AND  challan_date IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot delete voucher % — it has TDS deduction records with challan details '
      '(TDS already deposited to the government). '
      'Contact your CA before removing this voucher.',
      OLD.voucher_number
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_challan_complete_tds ON pramaana.vouchers;

CREATE TRIGGER trg_protect_challan_complete_tds
  BEFORE DELETE ON pramaana.vouchers
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_protect_challan_complete_tds();

GRANT EXECUTE ON FUNCTION pramaana.fn_protect_challan_complete_tds() TO authenticated, service_role;
