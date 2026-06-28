-- ── 036_pay_now.sql ──────────────────────────────────────────────────────────
-- Adds Pay Now infrastructure:
--   • paid_from_account + paid_at columns on pramaana.vouchers
--   • pramaana.company_payment_accounts table (manage "Pay From" accounts per company)
-- -----------------------------------------------------------------------------

-- 1. Extend vouchers table
ALTER TABLE pramaana.vouchers
  ADD COLUMN IF NOT EXISTS paid_from_account TEXT,
  ADD COLUMN IF NOT EXISTS paid_at            TIMESTAMPTZ;

-- 2. Company payment accounts
CREATE TABLE IF NOT EXISTS pramaana.company_payment_accounts (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT        NOT NULL REFERENCES registry.companies(id) ON DELETE CASCADE,
  label      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pramaana.company_payment_accounts ENABLE ROW LEVEL SECURITY;

-- Service-role full access (used by edge functions / server actions)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'pramaana'
      AND tablename  = 'company_payment_accounts'
      AND policyname = 'service_role_all'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "service_role_all"
        ON pramaana.company_payment_accounts
        FOR ALL TO service_role
        USING (true) WITH CHECK (true)
    $policy$;
  END IF;
END $$;

-- Authenticated users can manage their own company's accounts
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'pramaana'
      AND tablename  = 'company_payment_accounts'
      AND policyname = 'authenticated_all'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "authenticated_all"
        ON pramaana.company_payment_accounts
        FOR ALL TO authenticated
        USING (true) WITH CHECK (true)
    $policy$;
  END IF;
END $$;

GRANT ALL ON pramaana.company_payment_accounts TO authenticated;
GRANT ALL ON pramaana.company_payment_accounts TO anon;

-- 3. Index for fast company lookups
CREATE INDEX IF NOT EXISTS idx_cpa_company_id
  ON pramaana.company_payment_accounts (company_id, created_at);
