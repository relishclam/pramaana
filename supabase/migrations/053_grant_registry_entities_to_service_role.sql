-- ── Grant service_role SELECT on registry.entities ───────────────────────────
-- Migration: 053_grant_registry_entities_to_service_role.sql
-- Migration 051 granted access to companies/company_users/profiles.
-- The ocr edge function now also needs registry.entities for party name/GSTIN
-- correction (entity lookup after OCR extraction).

GRANT SELECT ON registry.entities TO service_role;
