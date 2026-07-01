-- ── 040_bill_allocations.sql ─────────────────────────────────────────────────
-- Bill Allocation Engine: links Payment/Receipt vouchers to the specific
-- Purchase/Sales bills they settle, enabling per-invoice outstanding tracking.
--
-- Invariant: SUM(open bill outstanding per entity) = entity ledger balance
-- This is a business-intelligence layer on top of the existing double-entry.
-- It does NOT change accounting entries — it only tracks allocation metadata.
--
-- Safe: Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.voucher_allocations (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID          NOT NULL REFERENCES registry.companies(id)  ON DELETE CASCADE,
  entity_id          UUID                   REFERENCES registry.entities(id)   ON DELETE SET NULL,
  bill_voucher_id    UUID          NOT NULL REFERENCES pramaana.vouchers(id)   ON DELETE CASCADE,
  payment_voucher_id UUID          NOT NULL REFERENCES pramaana.vouchers(id)   ON DELETE CASCADE,
  amount_allocated   NUMERIC(15,2) NOT NULL CHECK (amount_allocated > 0),
  is_advance         BOOLEAN       NOT NULL DEFAULT false,
  allocated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  allocated_by       UUID                   REFERENCES auth.users(id)          ON DELETE SET NULL,
  CONSTRAINT no_self_link CHECK (bill_voucher_id != payment_voucher_id)
);

COMMENT ON TABLE pramaana.voucher_allocations IS
  'Links payment/receipt vouchers to the specific purchase/sales bills they settle';

COMMENT ON COLUMN pramaana.voucher_allocations.bill_voucher_id IS
  'Purchase or Sales voucher being settled (the bill)';

COMMENT ON COLUMN pramaana.voucher_allocations.payment_voucher_id IS
  'Payment or Receipt voucher that settles the bill';

COMMENT ON COLUMN pramaana.voucher_allocations.is_advance IS
  'True when this allocation was created retroactively — the payment preceded the bill';

ALTER TABLE pramaana.voucher_allocations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'pramaana'
      AND tablename  = 'voucher_allocations'
      AND policyname = 'service_role_all'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "service_role_all"
        ON pramaana.voucher_allocations
        FOR ALL TO service_role
        USING (true) WITH CHECK (true)
    $policy$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'pramaana'
      AND tablename  = 'voucher_allocations'
      AND policyname = 'authenticated_all'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "authenticated_all"
        ON pramaana.voucher_allocations
        FOR ALL TO authenticated
        USING (true) WITH CHECK (true)
    $policy$;
  END IF;
END $$;

GRANT ALL ON pramaana.voucher_allocations TO authenticated;
GRANT ALL ON pramaana.voucher_allocations TO anon;

-- Indexes for the three main access patterns
CREATE INDEX IF NOT EXISTS idx_va_bill_voucher
  ON pramaana.voucher_allocations (bill_voucher_id);

CREATE INDEX IF NOT EXISTS idx_va_payment_voucher
  ON pramaana.voucher_allocations (payment_voucher_id);

CREATE INDEX IF NOT EXISTS idx_va_company_entity
  ON pramaana.voucher_allocations (company_id, entity_id);
