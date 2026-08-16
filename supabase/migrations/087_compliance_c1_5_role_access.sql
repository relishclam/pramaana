-- ════════════════════════════════════════════════════════════════════════════
-- 087_compliance_c1_5_role_access.sql — Phase C1.5
--
-- Adds category-level access control for the Compliance module.
-- A category matrix, not role forks: adding a future role (ESI/PF consultant,
-- labour-law advisor) is a seed row, not a code change.
--
-- New roles: 'cs' (Company Secretary) + 'gst_consultant'
-- Extends company_users.role constraint to allow these values.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Extend company_users.role to allow new specialist roles ───────────────
-- Drop the existing CHECK constraint (if any), re-add with extended values.

DO $$
DECLARE v_constraint TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_constraint
  FROM   information_schema.table_constraints tc
  WHERE  tc.table_schema  = 'registry'
    AND  tc.table_name    = 'company_users'
    AND  tc.constraint_type = 'CHECK'
    AND  tc.constraint_name ILIKE '%role%'
  LIMIT 1;

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE registry.company_users DROP CONSTRAINT %I', v_constraint);
    RAISE NOTICE 'Dropped role CHECK constraint: %', v_constraint;
  END IF;
END;
$$;

ALTER TABLE registry.company_users
  ADD CONSTRAINT company_users_role_check
  CHECK (role IN (
    'super_admin','admin','accounts','auditor',
    'cs',               -- Company Secretary: ROC filings, DIR-3 KYC
    'gst_consultant',   -- External GST practitioner: GSTR-1/3B
    'viewer'
  ));

-- ── 2. compliance_role_access ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS registry.compliance_role_access (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  role             TEXT    NOT NULL,
  category         TEXT    NOT NULL CHECK (category IN ('GST','TDS','ROC','IT','ALL')),
  can_view         BOOLEAN NOT NULL DEFAULT true,
  can_update_status BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (role, category)
);

ALTER TABLE registry.compliance_role_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cra_read ON registry.compliance_role_access;
CREATE POLICY cra_read ON registry.compliance_role_access
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cra_service ON registry.compliance_role_access;
CREATE POLICY cra_service ON registry.compliance_role_access
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 3. Seed role → category access matrix ────────────────────────────────────

INSERT INTO registry.compliance_role_access (role, category, can_view, can_update_status) VALUES
  -- super_admin and admin: full access to all categories
  ('super_admin',    'ALL',  true, true),
  ('admin',          'ALL',  true, true),

  -- accounts: full access (posts TDS vouchers, handles GST cash ledger)
  ('accounts',       'ALL',  true, true),

  -- auditor: view only across all categories
  ('auditor',        'ALL',  true, false),

  -- cs (Company Secretary): manages ROC filings, can view IT deadlines
  ('cs',             'ROC',  true, true),
  ('cs',             'IT',   true, false),

  -- gst_consultant: manages GST returns, can view TDS deadlines
  ('gst_consultant', 'GST',  true, true),
  ('gst_consultant', 'TDS',  true, false)

ON CONFLICT (role, category) DO NOTHING;

COMMENT ON TABLE registry.compliance_role_access IS
  'Maps company_users.role to compliance obligation categories. '
  'category=ALL means the rule covers all categories that don''t have a specific row. '
  'Adding a new specialist role is a seed row here — no code change required.';

-- ── 4. Helper function: categories visible to a user for a company ───────────

CREATE OR REPLACE FUNCTION registry.compliance_accessible_categories(
  p_user_id    UUID,
  p_company_id UUID
)
RETURNS TABLE (category TEXT, can_update_status BOOLEAN)
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
  SELECT DISTINCT
    CASE cra.category
      WHEN 'ALL' THEN unnested.cat
      ELSE cra.category
    END AS category,
    cra.can_update_status
  FROM registry.company_users cu
  JOIN registry.compliance_role_access cra ON cra.role = cu.role
  CROSS JOIN (
    VALUES ('GST'),('TDS'),('ROC'),('IT')
  ) AS unnested(cat)
  WHERE cu.user_id    = p_user_id
    AND cu.company_id = p_company_id
    AND cra.can_view  = true
  ORDER BY 1;
$$;

GRANT EXECUTE ON FUNCTION registry.compliance_accessible_categories(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION registry.compliance_accessible_categories(UUID, UUID) TO service_role;
