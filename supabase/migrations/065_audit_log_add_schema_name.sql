-- ── 065_audit_log_add_schema_name.sql ────────────────────────────────────────
-- Purpose : Reconcile audit_log schema with the production trigger function.
--           Production fn_audit_log() uses column names that migration 061
--           never created: schema_name, action, old_data, new_data.
-- Safe    : ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE FUNCTION. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pramaana.audit_log
  ADD COLUMN IF NOT EXISTS schema_name text;

-- Backfill before tightening — handles cases where column was added nullable by a partial run
UPDATE pramaana.audit_log SET schema_name = 'pramaana' WHERE schema_name IS NULL;

ALTER TABLE pramaana.audit_log
  ALTER COLUMN schema_name SET NOT NULL,
  ALTER COLUMN schema_name SET DEFAULT 'pramaana';

-- action = alias for operation (production trigger uses this name)
ALTER TABLE pramaana.audit_log
  ADD COLUMN IF NOT EXISTS action text
  CHECK (action IN ('INSERT','UPDATE','DELETE'));

-- old_data / new_data = aliases for old_row / new_row
ALTER TABLE pramaana.audit_log
  ADD COLUMN IF NOT EXISTS old_data jsonb;

ALTER TABLE pramaana.audit_log
  ADD COLUMN IF NOT EXISTS new_data jsonb;

-- user_id used by the legacy fn_audit_voucher trigger (alias for changed_by)
ALTER TABLE pramaana.audit_log
  ADD COLUMN IF NOT EXISTS user_id uuid;

-- Fix fn_audit_voucher to populate both user_id and changed_by, and add changed_via
CREATE OR REPLACE FUNCTION pramaana.fn_audit_voucher()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO pramaana.audit_log
      (company_id, schema_name, table_name, record_id, action, operation, old_data, old_row, user_id, changed_by, changed_via)
    VALUES (OLD.company_id, 'pramaana', TG_TABLE_NAME, OLD.id, 'DELETE', 'DELETE', to_jsonb(OLD), to_jsonb(OLD), v_uid, v_uid, 'app');
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO pramaana.audit_log
      (company_id, schema_name, table_name, record_id, action, operation, new_data, new_row, user_id, changed_by, changed_via)
    VALUES (NEW.company_id, 'pramaana', TG_TABLE_NAME, NEW.id, 'INSERT', 'INSERT', to_jsonb(NEW), to_jsonb(NEW), v_uid, v_uid, 'app');
    RETURN NEW;
  ELSE
    INSERT INTO pramaana.audit_log
      (company_id, schema_name, table_name, record_id, action, operation, old_data, old_row, new_data, new_row, user_id, changed_by, changed_via)
    VALUES (NEW.company_id, 'pramaana', TG_TABLE_NAME, NEW.id, 'UPDATE', 'UPDATE', to_jsonb(OLD), to_jsonb(OLD), to_jsonb(NEW), to_jsonb(NEW), v_uid, v_uid, 'app');
    RETURN NEW;
  END IF;
END;
$$;

-- Recreate the trigger function with all column variants populated
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
  v_old        jsonb;
  v_new        jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_record_id := OLD.id;
  ELSE
    v_record_id := NEW.id;
  END IF;

  BEGIN
    IF TG_OP = 'DELETE' THEN
      v_company_id := OLD.company_id;
    ELSE
      v_company_id := NEW.company_id;
    END IF;
  EXCEPTION WHEN undefined_column THEN
    v_company_id := NULL;
  END;

  v_caller := auth.uid();
  v_via    := CASE WHEN v_caller IS NULL THEN 'service' ELSE 'app' END;
  v_old    := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN row_to_json(OLD)::jsonb ELSE NULL END;
  v_new    := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN row_to_json(NEW)::jsonb ELSE NULL END;

  INSERT INTO pramaana.audit_log (
    schema_name,
    table_name,
    record_id,
    company_id,
    operation,
    action,
    old_row,
    new_row,
    old_data,
    new_data,
    changed_by,
    changed_via
  ) VALUES (
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME,
    v_record_id,
    v_company_id,
    TG_OP,
    TG_OP,
    v_old,
    v_new,
    v_old,
    v_new,
    v_caller,
    v_via
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;
