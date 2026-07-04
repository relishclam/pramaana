-- ── Tally XML Export — Migration 047 ────────────────────────────────────────
-- Purpose: Infrastructure for one-time historical voucher export to Tally Prime.
--
-- Two tables:
--   tally_ledger_master_import — scratch table; paste Tally's ledger list here
--   tally_ledger_map           — the verified Pramaana→Tally name mapping table
--
-- Every ledger/party name used in generated XML must come from tally_ledger_map
-- with is_verified=true. The export function fails loud if any name is missing.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Tally master ledger import (scratch / working table) ──────────────────
-- Populated by pasting Tally's "List of Accounts" export (CSV or manual entry).
-- Used only for auto-matching; not referenced by the export itself.

CREATE TABLE IF NOT EXISTS pramaana.tally_ledger_master_import (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID        NOT NULL,
  tally_name      TEXT        NOT NULL,   -- exact ledger name from Tally
  tally_group     TEXT,                   -- parent group from Tally master
  opening_balance NUMERIC(15,2),
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, tally_name)
);

ALTER TABLE pramaana.tally_ledger_master_import ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tally_master_access ON pramaana.tally_ledger_master_import;
CREATE POLICY tally_master_access ON pramaana.tally_ledger_master_import
  FOR ALL TO authenticated
  USING  (registry.is_super_admin())
  WITH CHECK (registry.is_super_admin());

-- ── 2. Ledger mapping table ───────────────────────────────────────────────────
-- Maps every Pramaana ledger / party / GST ledger to the EXACT Tally name.
-- is_verified must be TRUE for a name to be used in the export.
-- Human review is mandatory before any XML is generated.

CREATE TABLE IF NOT EXISTS pramaana.tally_ledger_map (
  id                    UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID    NOT NULL,
  pramaana_entity_type  TEXT    NOT NULL
    CHECK (pramaana_entity_type IN ('party', 'gl_account', 'gst_ledger', 'bank_ledger', 'cash_ledger')),
  pramaana_entity_id    UUID,               -- NULL for GST/fixed ledgers (no DB row)
  pramaana_display_name TEXT    NOT NULL,   -- human-readable, for review only
  tally_ledger_name     TEXT    NOT NULL,   -- EXACT string as it appears in Tally
  tally_parent_group    TEXT,               -- informational; sanity-check the mapping
  is_verified           BOOLEAN NOT NULL DEFAULT false,
  notes                 TEXT,               -- reviewer's optional comment
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Unique per company + display name (covers both null and non-null entity_id)
  UNIQUE (company_id, pramaana_display_name)
);

ALTER TABLE pramaana.tally_ledger_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tally_map_read  ON pramaana.tally_ledger_map;
DROP POLICY IF EXISTS tally_map_write ON pramaana.tally_ledger_map;
CREATE POLICY tally_map_read ON pramaana.tally_ledger_map
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY tally_map_write ON pramaana.tally_ledger_map
  FOR ALL TO authenticated
  USING  (registry.is_super_admin())
  WITH CHECK (registry.is_super_admin());

COMMENT ON TABLE pramaana.tally_ledger_map IS
  'Maps each Pramaana ledger/party to the exact Tally ledger name string. '
  'is_verified must be true for the row to be used in XML export.';

COMMENT ON COLUMN pramaana.tally_ledger_map.tally_ledger_name IS
  'Case-sensitive exact match of the ledger name in Tally Prime. '
  'Mismatches will create orphan ledgers in Tally on import.';

-- ── 3. Partial unique index — prevents duplicate mappings for the same entity ─
-- The UNIQUE (company_id, pramaana_display_name) constraint on the table only
-- enforces display-name uniqueness, not entity_id uniqueness. Without this
-- index, two rows can reference the same pramaana_entity_id with different
-- tally_ledger_name values — causing non-deterministic ledger selection during
-- export and silently exporting vouchers against the wrong Tally ledger.
--
-- Scoped to IS NOT NULL so that multiple NULL-entity rows (GST/bank/cash
-- ledgers that have no source DB row) are still allowed.

CREATE UNIQUE INDEX IF NOT EXISTS tally_ledger_map_entity_uq
  ON pramaana.tally_ledger_map (company_id, pramaana_entity_type, pramaana_entity_id)
  WHERE pramaana_entity_id IS NOT NULL;

-- ── 4. Index supporting pre-flight validation query ───────────────────────────
-- Part D.3 of the export plan runs: find all unverified mappings for a company.
-- This index makes that query a fast index scan rather than a full table scan.

CREATE INDEX IF NOT EXISTS tally_ledger_map_unverified_idx
  ON pramaana.tally_ledger_map (company_id, is_verified);

-- ── 5. Auto-update updated_at on row change ───────────────────────────────────
-- Without this, updated_at silently stays at created_at after every edit,
-- making it useless as a "reviewed recently" signal during the mapping review.

CREATE OR REPLACE FUNCTION pramaana.tally_ledger_map_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tally_ledger_map_updated_at ON pramaana.tally_ledger_map;

CREATE TRIGGER trg_tally_ledger_map_updated_at
  BEFORE UPDATE ON pramaana.tally_ledger_map
  FOR EACH ROW EXECUTE FUNCTION pramaana.tally_ledger_map_set_updated_at();

-- ── Design decisions documented ───────────────────────────────────────────────
-- Two entities → same Tally ledger: NOT blocked at DB level.
--   This is intentional: multiple voucher entry lines legitimately route to the
--   same CGST/SGST/IGST output ledger. A hard uniqueness constraint on
--   tally_ledger_name would break those mappings.
--   Risk mitigation: the review UI (TallyExport.tsx Tab 2) should surface a
--   warning "N other entities already map to this Tally ledger" at verification
--   time so a human reviewer catches accidental collisions before export.
--   A wrong party-to-party collision (two vendors pointing at the same Tally
--   ledger) is a data-entry error that should be caught in review, not silently
--   permitted or silently blocked by a constraint that also breaks valid GST use.
