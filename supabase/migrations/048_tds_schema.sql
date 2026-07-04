-- ── TDS Schema Prerequisites — Migration 048 ─────────────────────────────────
-- Purpose: Add tds_section_code to pramaana.ledgers so TDS deductions can be
--          categorised by the correct Income Tax section (194C, 194J, etc.).
--
-- Existing TDS columns (already present, no changes needed):
--   pramaana.ledgers.is_tds_applicable  BOOLEAN DEFAULT FALSE
--   pramaana.ledgers.tds_rate           NUMERIC(5,2)
--
-- New column:
--   pramaana.ledgers.tds_section_code   TEXT
--
-- This is step 1 of 3 for TDS. Full Form 26Q reporting also requires:
--   Step 2 — migration 049: voucher_tds_deductions (per-transaction TDS amounts)
--   Step 3 — challan capture: BSR code / deposit date / serial per quarter
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pramaana.ledgers
  ADD COLUMN IF NOT EXISTS tds_section_code TEXT;

-- ── Soft format guard ─────────────────────────────────────────────────────────
-- Accepts standard IT section-code patterns: 2–3 digits optionally followed
-- by one capital letter (e.g. 192, 194C, 194Q, 206AB).
-- Free-text CHECK rather than a closed enum — new sections are added by
-- the government periodically and should not require a DB migration to use.
ALTER TABLE pramaana.ledgers
  DROP CONSTRAINT IF EXISTS tds_section_code_format;

ALTER TABLE pramaana.ledgers
  ADD CONSTRAINT tds_section_code_format
  CHECK (tds_section_code IS NULL OR tds_section_code ~ '^[0-9]{2,3}[A-Z]?[A-Z]?$');

-- ── Consistency guard ─────────────────────────────────────────────────────────
-- If a ledger is marked TDS-applicable, it must have a section code.
-- A section code on a non-applicable ledger is harmless but confusing —
-- block it too so the data stays clean.
ALTER TABLE pramaana.ledgers
  DROP CONSTRAINT IF EXISTS tds_section_required_if_applicable;

ALTER TABLE pramaana.ledgers
  ADD CONSTRAINT tds_section_required_if_applicable
  CHECK (
    (NOT is_tds_applicable OR tds_section_code IS NOT NULL)
    AND
    (tds_section_code IS NULL OR is_tds_applicable)
  );

COMMENT ON COLUMN pramaana.ledgers.tds_section_code IS
  'Income Tax Act section under which TDS is deducted. '
  'Common values: 192 (salary), 194 (dividends), 194A (interest), '
  '194C (contractors), 194H (commission), 194I (rent), '
  '194J (professional/technical), 194Q (purchase >₹50L). '
  'Must be set when is_tds_applicable = true.';

