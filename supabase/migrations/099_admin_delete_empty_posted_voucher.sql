-- ── 099_admin_delete_empty_posted_voucher.sql ────────────────────────────────
--
-- PURPOSE
--   One-off admin RPC to delete a posted voucher that has zero accounting
--   entries (orphan created by a failed import run before the import script
--   was corrected to use draft→entries→post sequencing).
--
-- SAFETY
--   Refuses to delete if any voucher_entries row exists for the voucher.
--   Uses app.pramaana_reset_bypass (migration 054) to pass the immutability
--   trigger — same mechanism already used by pramaana_reset_company_data.
--   GRANT is to service_role only; not exposed to authenticated users.
--
-- SAFE: CREATE OR REPLACE — idempotent, re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pramaana.admin_delete_empty_posted_voucher(p_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_number TEXT;
BEGIN
  SELECT voucher_number INTO v_number
  FROM pramaana.vouchers WHERE id = p_id;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Voucher not found: %', p_id;
  END IF;

  IF EXISTS (SELECT 1 FROM pramaana.voucher_entries WHERE voucher_id = p_id LIMIT 1) THEN
    RAISE EXCEPTION 'Safety: voucher % has entries — use a reversing journal', v_number;
  END IF;

  SET LOCAL "app.pramaana_reset_bypass" = 'true';
  DELETE FROM pramaana.vouchers WHERE id = p_id;

  RETURN 'Deleted ' || v_number;
END;
$$;

GRANT EXECUTE ON FUNCTION pramaana.admin_delete_empty_posted_voucher(UUID) TO service_role;
