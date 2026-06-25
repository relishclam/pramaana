-- ====================================================================
-- PRAMAANA: Link Peninsular Fisheries ledger → registry entity
-- ====================================================================
--
-- PREREQUISITE — Create the entity in Relish Suite FIRST:
--   Suite → Entity Master → New Entity
--     Display name : Peninsular Fisheries Pvt Ltd
--     GSTIN        : 33AAHCP7132Q1ZZ
--     Role         : Customer  (company: RFPL)
--   Save → copy the UUID assigned to the new entity.
--
-- Then run this script in:
--   Pramaana Supabase (mmkbknnzgpvsqgnynrbe) → SQL Editor
--
-- Replace the placeholder UUID below with the actual entity_id
-- from registry.entities (or look it up via the SELECT at the bottom).
-- ====================================================================

DO $link$
DECLARE
  v_rfpl      UUID;
  v_entity_id UUID;
BEGIN
  SELECT id INTO v_rfpl FROM registry.companies WHERE code = 'RFPL';
  IF v_rfpl IS NULL THEN RAISE EXCEPTION 'RFPL not found in registry.companies'; END IF;

  -- Look up entity by GSTIN (created in Suite)
  SELECT id INTO v_entity_id
  FROM registry.entities
  WHERE gstin = '33AAHCP7132Q1ZZ';

  IF v_entity_id IS NULL THEN
    RAISE EXCEPTION
      'Entity "Peninsular Fisheries Pvt Ltd" (GSTIN 33AAHCP7132Q1ZZ) not found. '
      'Create it in Relish Suite → Entity Master first.';
  END IF;

  -- Link the pramaana.ledger entry (created by seed 043) to the entity.
  -- This enables GSTIN auto-match in the Pramaana invoice scan flow.
  UPDATE pramaana.ledgers
  SET entity_id = v_entity_id
  WHERE company_id = v_rfpl
    AND name = 'Peninsular Fisheries Pvt Ltd';

  IF NOT FOUND THEN
    RAISE WARNING
      'Ledger "Peninsular Fisheries Pvt Ltd" not found for RFPL — run 043 first.';
  ELSE
    RAISE NOTICE '✓ pramaana.ledgers.entity_id set to % for Peninsular Fisheries Pvt Ltd', v_entity_id;
  END IF;

END;
$link$;

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT
  e.id            AS entity_id,
  e.display_name,
  e.gstin,
  er.role,
  c.code          AS company,
  l.name          AS ledger_name,
  l.entity_id     AS ledger_entity_id
FROM registry.entities e
JOIN registry.entity_roles er ON er.entity_id = e.id
JOIN registry.companies    c  ON c.id = er.company_id
LEFT JOIN pramaana.ledgers l  ON l.entity_id = e.id AND l.company_id = er.company_id
WHERE e.gstin = '33AAHCP7132Q1ZZ';
