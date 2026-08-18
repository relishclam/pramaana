-- ════════════════════════════════════════════════════════════════════════════
-- 093_upsert_entity_payee_rpc.sql
--
-- SECURITY DEFINER RPC so the authenticated frontend can upsert into
-- registry.entities + registry.entity_bank_accounts without direct table grants.
-- Called by AdminPanel → Import: Vendors tab.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.upsert_entity_payee(
  p_display_name TEXT,
  p_mobile       TEXT    DEFAULT NULL,
  p_email        TEXT    DEFAULT NULL,
  p_gstin        TEXT    DEFAULT NULL,
  p_pan          TEXT    DEFAULT NULL,
  p_upi_id       TEXT    DEFAULT NULL,
  p_bank_name    TEXT    DEFAULT NULL,
  p_bank_account TEXT    DEFAULT NULL,
  p_bank_ifsc    TEXT    DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, public
AS $$
DECLARE
  v_id UUID;
BEGIN
  -- Find existing entity by exact case-insensitive name
  SELECT id INTO v_id
  FROM   registry.entities
  WHERE  lower(trim(display_name)) = lower(trim(p_display_name))
  LIMIT  1;

  IF v_id IS NULL THEN
    INSERT INTO registry.entities (display_name, mobile, email, gstin, pan)
    VALUES (p_display_name, p_mobile, p_email, p_gstin, p_pan)
    RETURNING id INTO v_id;
  ELSE
    -- Fill in missing fields only; never overwrite existing data
    UPDATE registry.entities SET
      mobile = COALESCE(mobile, p_mobile),
      email  = COALESCE(email,  p_email),
      gstin  = COALESCE(gstin,  p_gstin),
      pan    = COALESCE(pan,    p_pan)
    WHERE id = v_id;
  END IF;

  -- Upsert primary bank account / UPI if any payment data supplied
  IF p_upi_id IS NOT NULL OR p_bank_account IS NOT NULL THEN
    INSERT INTO registry.entity_bank_accounts
      (entity_id, label, upi_id, bank_name, bank_account_number, bank_ifsc, is_primary, is_active)
    VALUES
      (v_id, 'Primary', p_upi_id, p_bank_name, p_bank_account, p_bank_ifsc, true, true)
    ON CONFLICT (entity_id) WHERE is_primary = true AND is_active = true
    DO UPDATE SET
      upi_id              = COALESCE(EXCLUDED.upi_id,              entity_bank_accounts.upi_id),
      bank_account_number = COALESCE(EXCLUDED.bank_account_number, entity_bank_accounts.bank_account_number),
      bank_ifsc           = COALESCE(EXCLUDED.bank_ifsc,           entity_bank_accounts.bank_ifsc),
      bank_name           = COALESCE(EXCLUDED.bank_name,           entity_bank_accounts.bank_name);
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_entity_payee(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)
  TO authenticated, service_role;
