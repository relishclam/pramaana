-- ── Inventory Valuations ──────────────────────────────────────────────────────
-- Purpose : Store Admin/Super-Admin-set rates for ClamFlow lots in Pramaana.
--           ClamFlow is READ-ONLY from Pramaana — we only store the valuation.
-- Run in  : Supabase SQL editor → project mmkbknnzgpvsqgnynrbe
-- Safe    : All statements are idempotent (IF NOT EXISTS / OR REPLACE)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.inventory_valuations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID        NOT NULL,
  -- ClamFlow lot UUID stored as text (cross-database reference, never FK)
  lot_id        TEXT        NOT NULL,
  rate_per_kg   NUMERIC(12, 2)  NOT NULL CHECK (rate_per_kg >= 0),
  notes         TEXT,
  valued_by     UUID        REFERENCES auth.users(id),
  valued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (company_id, lot_id)
);

CREATE INDEX IF NOT EXISTS idx_inv_val_company ON pramaana.inventory_valuations(company_id);
CREATE INDEX IF NOT EXISTS idx_inv_val_lot     ON pramaana.inventory_valuations(lot_id);

-- ── 2. updated_at trigger ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pramaana.set_inv_val_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inv_val_updated_at ON pramaana.inventory_valuations;
CREATE TRIGGER trg_inv_val_updated_at
  BEFORE UPDATE ON pramaana.inventory_valuations
  FOR EACH ROW EXECUTE FUNCTION pramaana.set_inv_val_updated_at();

-- ── 3. RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE pramaana.inventory_valuations ENABLE ROW LEVEL SECURITY;

-- Any company member can read valuations
CREATE POLICY "company members can view inventory valuations"
  ON pramaana.inventory_valuations FOR SELECT
  TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users
      WHERE user_id = auth.uid()
    )
  );

-- Only admin role can write (insert/update/delete)
CREATE POLICY "admin can manage inventory valuations"
  ON pramaana.inventory_valuations FOR ALL
  TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users
      WHERE user_id = auth.uid()
        AND role = 'admin'
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM registry.company_users
      WHERE user_id = auth.uid()
        AND role = 'admin'
    )
  );
