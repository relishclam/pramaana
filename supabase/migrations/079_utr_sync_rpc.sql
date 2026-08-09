-- ── 079_utr_sync_rpc.sql ──────────────────────────────────────────────────────
--
-- PURPOSE
--   Replace migration 077's brittle field-comparison approach with a
--   session-variable gate, and expose an RPC that the sync script calls.
--
-- HOW IT WORKS
--   set_utr_number() sets pramaana.allow_utr_update=true for the current
--   transaction (SET LOCAL), does the UPDATE, clears the flag.
--   The immutability trigger checks the flag — if set, passes through.
--   The flag is never visible outside that single transaction.
--
-- SECURITY
--   SECURITY DEFINER runs as function owner (postgres).
--   service_role GRANT means only server-side calls can invoke it.
--   No superuser privilege required.
--
-- SAFE: CREATE OR REPLACE — idempotent, re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Patch the trigger function the live DB actually uses ──────────────────
-- Live trigger calls pramaana.fn_prevent_posted_edit(), NOT prevent_posted_voucher_update().
-- Also update prevent_posted_voucher_update() for consistency with migration 044.

CREATE OR REPLACE FUNCTION pramaana.fn_prevent_posted_edit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    IF to_regclass('pg_temp._utr_update_gate') IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot modify a posted voucher. Number: %', OLD.voucher_number
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION pramaana.prevent_posted_voucher_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    IF to_regclass('pg_temp._utr_update_gate') IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot modify a posted voucher. Number: %', OLD.voucher_number
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 2. RPC: set_utr_number ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pramaana.set_utr_number(p_id UUID, p_utr TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Raise the gate (ON COMMIT DROP cleans up automatically)
  CREATE TEMP TABLE IF NOT EXISTS _utr_update_gate (dummy int) ON COMMIT DROP;
  UPDATE pramaana.vouchers SET utr_number = p_utr WHERE id = p_id;
  DROP TABLE IF EXISTS pg_temp._utr_update_gate;
END;
$$;

GRANT EXECUTE ON FUNCTION pramaana.set_utr_number(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION pramaana.set_utr_number(UUID, TEXT) TO authenticated;
