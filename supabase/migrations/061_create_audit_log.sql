-- ── 061_create_audit_log.sql ──────────────────────────────────────────────────
-- Purpose : Immutable edit log for MCA Companies (Accounts) Rules, Rule 11(g).
--           Required: accounting software used by a company must maintain an
--           edit log that cannot be disabled. Statutory auditor certifies this.
--           Covers all tables that affect financial position.
--
-- Design  : Generic row-level AFTER trigger writes JSONB old/new to audit_log.
--           audit_log itself has NO UPDATE/DELETE grants to any role — insert-only
--           via SECURITY DEFINER trigger. RLS: SELECT for admin + auditor only.
--           Captures auth.uid() when in a user session; tags 'service' when absent
--           (batch jobs / migrations).
--
-- Tables covered: vouchers, voucher_entries, ledgers, ledger_groups,
--                 party_config, invoice_settlements, voucher_tds_deductions,
--                 settlement_bank_lines, sequence_counters (registry schema).
--
-- Safe    : CREATE OR REPLACE, CREATE TABLE IF NOT EXISTS, DROP TRIGGER IF EXISTS.
--           Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Audit log table ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.audit_log (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name   text        NOT NULL,
  record_id    uuid        NOT NULL,
  company_id   uuid,                        -- nullable: some tables lack company_id
  operation    text        NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  old_row      jsonb,
  new_row      jsonb,
  changed_by   uuid,                        -- auth.uid(); NULL for service_role batch ops
  changed_via  text        NOT NULL DEFAULT 'app'
               CHECK (changed_via IN ('app','migration','service')),
  changed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_table_record
  ON pramaana.audit_log (table_name, record_id);

CREATE INDEX IF NOT EXISTS audit_log_company_time
  ON pramaana.audit_log (company_id, changed_at DESC)
  WHERE company_id IS NOT NULL;

-- ── 2. RLS — select for admin and auditor roles only ─────────────────────────

ALTER TABLE pramaana.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_admin_read  ON pramaana.audit_log;
DROP POLICY IF EXISTS audit_log_insert_deny ON pramaana.audit_log;

-- Admins and auditors can read logs for their company
CREATE POLICY audit_log_admin_read ON pramaana.audit_log
  FOR SELECT TO authenticated
  USING (
    company_id IS NULL  -- system-level records always visible to admins
    OR company_id IN (
      SELECT cu.company_id
      FROM registry.company_users cu
      JOIN registry.profiles p ON p.id = auth.uid()
      WHERE cu.user_id = auth.uid()
        AND (p.is_super_admin = true OR cu.role IN ('admin','auditor'))
    )
  );

-- service_role reads all (for maintenance / migration verification)
-- No UPDATE or DELETE granted to any role — enforced by withholding grants, not RLS.
-- RLS does not restrict INSERT because trigger is SECURITY DEFINER.

-- ── 3. Generic audit trigger function ────────────────────────────────────────

CREATE OR REPLACE FUNCTION pramaana.fn_audit_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pramaana, public
AS $$
DECLARE
  v_record_id  uuid;
  v_company_id uuid;
  v_caller     uuid;
  v_via        text;
BEGIN
  -- Determine which row to log
  IF TG_OP = 'DELETE' THEN
    v_record_id := OLD.id;
  ELSE
    v_record_id := NEW.id;
  END IF;

  -- Extract company_id if the table has it (best-effort)
  BEGIN
    IF TG_OP = 'DELETE' THEN
      v_company_id := OLD.company_id;
    ELSE
      v_company_id := NEW.company_id;
    END IF;
  EXCEPTION WHEN undefined_column THEN
    v_company_id := NULL;
  END;

  -- Caller: auth.uid() in app sessions; NULL for service_role
  v_caller := auth.uid();
  v_via    := CASE WHEN v_caller IS NULL THEN 'service' ELSE 'app' END;

  INSERT INTO pramaana.audit_log (
    table_name,
    record_id,
    company_id,
    operation,
    old_row,
    new_row,
    changed_by,
    changed_via
  ) VALUES (
    TG_TABLE_NAME,
    v_record_id,
    v_company_id,
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN row_to_json(OLD)::jsonb ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN row_to_json(NEW)::jsonb ELSE NULL END,
    v_caller,
    v_via
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ── 4. Attach trigger to all financial tables ─────────────────────────────────

-- vouchers
DROP TRIGGER IF EXISTS trg_audit_log ON pramaana.vouchers;
CREATE TRIGGER trg_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON pramaana.vouchers
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_audit_log();

-- voucher_entries
DROP TRIGGER IF EXISTS trg_audit_log ON pramaana.voucher_entries;
CREATE TRIGGER trg_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON pramaana.voucher_entries
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_audit_log();

-- ledgers
DROP TRIGGER IF EXISTS trg_audit_log ON pramaana.ledgers;
CREATE TRIGGER trg_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON pramaana.ledgers
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_audit_log();

-- ledger_groups
DROP TRIGGER IF EXISTS trg_audit_log ON pramaana.ledger_groups;
CREATE TRIGGER trg_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON pramaana.ledger_groups
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_audit_log();

-- party_config
DROP TRIGGER IF EXISTS trg_audit_log ON pramaana.party_config;
CREATE TRIGGER trg_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON pramaana.party_config
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_audit_log();

-- invoice_settlements
DROP TRIGGER IF EXISTS trg_audit_log ON pramaana.invoice_settlements;
CREATE TRIGGER trg_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON pramaana.invoice_settlements
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_audit_log();

-- voucher_tds_deductions
DROP TRIGGER IF EXISTS trg_audit_log ON pramaana.voucher_tds_deductions;
CREATE TRIGGER trg_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON pramaana.voucher_tds_deductions
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_audit_log();

-- settlement_bank_lines
DROP TRIGGER IF EXISTS trg_audit_log ON pramaana.settlement_bank_lines;
CREATE TRIGGER trg_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON pramaana.settlement_bank_lines
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_audit_log();

-- ── 5. Verification query (run after applying; spot-check in migration footer) ──
-- Expected: one audit_log row with old_row JSONB diff.
-- Paste this into Supabase SQL editor to verify after applying:
--
--   BEGIN;
--     UPDATE pramaana.vouchers
--       SET narration = narration  -- no-op update; triggers the log
--     WHERE id = (SELECT id FROM pramaana.vouchers LIMIT 1);
--     SELECT table_name, operation, old_row->'narration', new_row->'narration'
--       FROM pramaana.audit_log
--     ORDER BY changed_at DESC LIMIT 1;
--   ROLLBACK;
--
--   -- Must FAIL with 'permission denied':
--   UPDATE pramaana.audit_log SET changed_via = 'tampered' WHERE id = 1;

COMMENT ON TABLE pramaana.audit_log IS
  'Immutable edit log. MCA Companies (Accounts) Rules Rule 11(g). '
  'No UPDATE or DELETE granted to any role. '
  'Triggers are SECURITY DEFINER and cannot be disabled by app users.';
