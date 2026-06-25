-- ── Scan Ref Sequence — Migration 034 ────────────────────────────────────────
-- Creates a dedicated scan sequence counter table and next_scan_ref() RPC.
-- Produces scan_refs like: RFPL/2627/PUR/20260625-0001
-- Uses scan date (today) for the date component and FY calculation.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Scan sequence counter table ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.scan_sequence_counters (
  company_id  uuid    NOT NULL,
  type_code   text    NOT NULL CHECK (type_code IN ('PUR', 'SAL')),
  fy          integer NOT NULL,   -- FY start year, e.g. 2026 for FY 26-27
  last_number integer NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, type_code, fy)
);

ALTER TABLE pramaana.scan_sequence_counters ENABLE ROW LEVEL SECURITY;

GRANT ALL ON pramaana.scan_sequence_counters TO service_role;

-- ── 2. next_scan_ref() function ───────────────────────────────────────────────
-- Atomically increments the counter and returns a formatted scan_ref string.
-- Called from the OCR edge function via service_role.

CREATE OR REPLACE FUNCTION pramaana.next_scan_ref(
  p_company_id   uuid,
  p_company_code text,
  p_type         text,              -- 'purchase' | 'sale'
  p_scan_date    date DEFAULT CURRENT_DATE
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pramaana, registry, public
AS $$
DECLARE
  v_fy_year   integer;
  v_fy_text   text;
  v_type_code text;
  v_seq       integer;
  v_date_str  text;
BEGIN
  -- Indian financial year starts April 1
  v_fy_year := CASE
    WHEN EXTRACT(MONTH FROM p_scan_date) >= 4
      THEN EXTRACT(YEAR FROM p_scan_date)::integer
    ELSE EXTRACT(YEAR FROM p_scan_date)::integer - 1
  END;

  -- FY text: 2626 for FY 2026-27
  v_fy_text := LPAD((v_fy_year       % 100)::text, 2, '0')
            || LPAD(((v_fy_year + 1) % 100)::text, 2, '0');

  v_type_code := CASE WHEN lower(p_type) = 'sale' THEN 'SAL' ELSE 'PUR' END;
  v_date_str  := to_char(p_scan_date, 'YYYYMMDD');

  -- Atomic upsert + increment
  INSERT INTO pramaana.scan_sequence_counters (company_id, type_code, fy, last_number)
  VALUES (p_company_id, v_type_code, v_fy_year, 1)
  ON CONFLICT (company_id, type_code, fy)
  DO UPDATE SET last_number = pramaana.scan_sequence_counters.last_number + 1
  RETURNING last_number INTO v_seq;

  RETURN p_company_code
      || '/' || v_fy_text
      || '/' || v_type_code
      || '/' || v_date_str
      || '-' || LPAD(v_seq::text, 4, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION pramaana.next_scan_ref(uuid, text, text, date)
  TO authenticated, service_role;

-- ── 3. Also add gstin column to invoice_scans if not present ─────────────────
-- (our_gstin stores the validated company GSTIN at scan time)
-- Already in the 20260625 migration — this is a safety no-op.
ALTER TABLE pramaana.invoice_scans
  ADD COLUMN IF NOT EXISTS our_gstin text;
