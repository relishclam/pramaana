-- ── Migration 068 — registry.entity_bank_accounts ────────────────────────────
--
-- Adds a multi-bank-account child table for registry.entities, mirroring the
-- existing registry.company_bank_accounts pattern.
--
-- Flat columns on registry.entities (bank_account_number, bank_ifsc, bank_name)
-- are intentionally NOT dropped — they remain as a legacy fallback read by
-- approvals.ts, vouchers-list.ts, sms.ts until those callers are migrated.
--
-- After creating the table, this migration:
--   1. Migrates existing non-null bank data from registry.entities (is_primary=true)
--   2. Inserts management person bank accounts (Motty Philip, Sherine Motty, Tarun Philip)
--   3. Inserts entity_roles rows for all three management persons

-- ── 1. Create table ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS registry.entity_bank_accounts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           UUID        NOT NULL REFERENCES registry.entities(id) ON DELETE CASCADE,
  label               TEXT,
  bank_name           TEXT,
  bank_account_number TEXT,
  bank_ifsc           TEXT,
  upi_id              TEXT,
  is_primary          BOOLEAN     NOT NULL DEFAULT false,
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entity_bank_accounts_entity_id_idx
  ON registry.entity_bank_accounts (entity_id);

-- Only one active primary per entity
CREATE UNIQUE INDEX IF NOT EXISTS entity_bank_accounts_primary_uq
  ON registry.entity_bank_accounts (entity_id)
  WHERE is_primary = true AND is_active = true;

COMMENT ON TABLE registry.entity_bank_accounts IS
  'Multiple bank accounts per entity. Mirrors registry.company_bank_accounts.
   Flat columns on registry.entities (bank_account_number, bank_ifsc, bank_name)
   retained as legacy fallback — do not drop, still read by approvals.ts,
   vouchers-list.ts, sms.ts.';

-- ── 2. RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE registry.entity_bank_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entity_bank_accounts_read  ON registry.entity_bank_accounts;
DROP POLICY IF EXISTS entity_bank_accounts_write ON registry.entity_bank_accounts;

-- Admin / accounts / auditor can read; super_admin bypasses RLS
CREATE POLICY entity_bank_accounts_read ON registry.entity_bank_accounts
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM registry.profiles p
      WHERE p.id = auth.uid()
        AND (
          p.is_super_admin = true
          OR EXISTS (
            SELECT 1 FROM registry.company_users cu
            WHERE cu.user_id = auth.uid()
              AND cu.role IN ('admin','accounts','auditor')
              AND cu.is_active = true
          )
        )
    )
  );

-- Admin / accounts can write
CREATE POLICY entity_bank_accounts_write ON registry.entity_bank_accounts
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM registry.profiles p
      WHERE p.id = auth.uid()
        AND (
          p.is_super_admin = true
          OR EXISTS (
            SELECT 1 FROM registry.company_users cu
            WHERE cu.user_id = auth.uid()
              AND cu.role IN ('admin','accounts')
              AND cu.is_active = true
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM registry.profiles p
      WHERE p.id = auth.uid()
        AND (
          p.is_super_admin = true
          OR EXISTS (
            SELECT 1 FROM registry.company_users cu
            WHERE cu.user_id = auth.uid()
              AND cu.role IN ('admin','accounts')
              AND cu.is_active = true
          )
        )
    )
  );

-- ── 3. Migrate existing non-null bank data from registry.entities ──────────────
--
-- Any entity that already has bank_account_number filled gets one row in
-- entity_bank_accounts with is_primary = true, preserving the data.
-- Skips entities whose bank_account_number looks like a bank name (all-alpha).

INSERT INTO registry.entity_bank_accounts
  (entity_id, label, bank_name, bank_account_number, bank_ifsc, is_primary, is_active)
SELECT
  e.id,
  'Primary',
  e.bank_name,
  e.bank_account_number,
  e.bank_ifsc,
  true,
  true
FROM registry.entities e
WHERE e.bank_account_number IS NOT NULL
  AND e.bank_account_number ~ '[0-9]'          -- exclude all-alpha "bank name" entries
ON CONFLICT DO NOTHING;

-- ── 4. Management person bank accounts ────────────────────────────────────────
--
-- These override any migrated row for the three management persons.
-- We delete any auto-migrated rows for them first, then insert the correct set.
-- Uses display_name match — safe because these names are unique in the registry.

DO $$
DECLARE
  motty_id   UUID;
  sherine_id UUID;
  tarun_id   UUID;
BEGIN

  -- Look up entity IDs by display_name (case-insensitive, trimmed)
  SELECT id INTO motty_id   FROM registry.entities WHERE lower(trim(display_name)) = 'motty philip'   LIMIT 1;
  SELECT id INTO sherine_id FROM registry.entities WHERE lower(trim(display_name)) = 'sherine motty'  LIMIT 1;
  SELECT id INTO tarun_id   FROM registry.entities WHERE lower(trim(display_name)) = 'tarun philip'   LIMIT 1;

  -- ── Motty Philip ────────────────────────────────────────────────────────────
  IF motty_id IS NOT NULL THEN
    DELETE FROM registry.entity_bank_accounts WHERE entity_id = motty_id;

    INSERT INTO registry.entity_bank_accounts
      (entity_id, label, bank_name, bank_account_number, bank_ifsc, upi_id, is_primary, is_active)
    VALUES
      (motty_id, 'KVB Alappuzha',      'Karur Vysya Bank', '1520155000001092', 'KVBL0001520', NULL,                    false, true),
      (motty_id, 'ICICI Alappuzha',    'ICICI Bank',       '060601506230',     'ICIC0000606', 'motty.philip@okicici',  true,  true),
      (motty_id, 'Bandhan Tirunelveli','Bandhan Bank',      '20200128944873',   'BDBL0001870', NULL,                    false, true);
  END IF;

  -- ── Sherine Motty ───────────────────────────────────────────────────────────
  IF sherine_id IS NOT NULL THEN
    DELETE FROM registry.entity_bank_accounts WHERE entity_id = sherine_id;

    INSERT INTO registry.entity_bank_accounts
      (entity_id, label, bank_name, bank_account_number, bank_ifsc, upi_id, is_primary, is_active)
    VALUES
      (sherine_id, 'SIB Alappuzha',    'South Indian Bank','0915053000001666', 'SIBL0000915', NULL,                     true,  true),
      (sherine_id, 'Federal Alappuzha','Federal Bank',     '10150100108712',   'FDRL0001015', 'sherinemotty@okaxis',    false, true);
  END IF;

  -- ── Tarun Philip ────────────────────────────────────────────────────────────
  IF tarun_id IS NOT NULL THEN
    DELETE FROM registry.entity_bank_accounts WHERE entity_id = tarun_id;

    INSERT INTO registry.entity_bank_accounts
      (entity_id, label, bank_name, bank_account_number, bank_ifsc, upi_id, is_primary, is_active)
    VALUES
      (tarun_id, 'Federal Alappuzha', 'Federal Bank', '10150100305318', 'FDRL0001015', 'tarunphilip2308@okhdfcbank', true,  true),
      (tarun_id, 'ICICI Alappuzha',   'ICICI Bank',   '060601506231',   'ICIC0000606', NULL,                          false, true);
  END IF;

END $$;

-- ── 5. entity_roles — management persons ──────────────────────────────────────
--
-- RFPL = bc455c94-0bcd-4d66-a040-d29ed880d22f
-- RHHF = b8beb440-df7f-48e8-a012-ac5750502eca
--
-- Inserts are ON CONFLICT DO NOTHING — safe to re-run.
-- entity_id resolved by display_name; if the entity does not yet exist in the
-- registry (pre-import) these inserts will silently skip — re-run after import.

DO $$
DECLARE
  rfpl UUID := 'bc455c94-0bcd-4d66-a040-d29ed880d22f';
  rhhf UUID := 'b8beb440-df7f-48e8-a012-ac5750502eca';
  motty_id   UUID;
  sherine_id UUID;
  tarun_id   UUID;
BEGIN
  SELECT id INTO motty_id   FROM registry.entities WHERE lower(trim(display_name)) = 'motty philip'   LIMIT 1;
  SELECT id INTO sherine_id FROM registry.entities WHERE lower(trim(display_name)) = 'sherine motty'  LIMIT 1;
  SELECT id INTO tarun_id   FROM registry.entities WHERE lower(trim(display_name)) = 'tarun philip'   LIMIT 1;

  -- Motty Philip
  IF motty_id IS NOT NULL THEN
    INSERT INTO registry.entity_roles (entity_id, company_id, role, is_active, end_date)
    VALUES
      (motty_id, rfpl, 'executive_director', true,  NULL),
      (motty_id, rhhf, 'managing_partner',   true,  NULL)
    ON CONFLICT (entity_id, company_id, role) DO UPDATE
      SET is_active = EXCLUDED.is_active, end_date = EXCLUDED.end_date;
  END IF;

  -- Tarun Philip
  IF tarun_id IS NOT NULL THEN
    INSERT INTO registry.entity_roles (entity_id, company_id, role, is_active, end_date)
    VALUES
      (tarun_id, rfpl, 'director', true, NULL),
      (tarun_id, rhhf, 'partner',  true, NULL)
    ON CONFLICT (entity_id, company_id, role) DO UPDATE
      SET is_active = EXCLUDED.is_active, end_date = EXCLUDED.end_date;
  END IF;

  -- Sherine Motty
  IF sherine_id IS NOT NULL THEN
    INSERT INTO registry.entity_roles (entity_id, company_id, role, is_active, end_date)
    VALUES
      (sherine_id, rfpl, 'director',         true,  NULL),
      (sherine_id, rhhf, 'retired_partner',  false, '2023-02-20')
    ON CONFLICT (entity_id, company_id, role) DO UPDATE
      SET is_active = EXCLUDED.is_active, end_date = EXCLUDED.end_date;
  END IF;

END $$;
