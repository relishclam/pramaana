-- ── Grant PostgREST role access to registry schema ───────────────────────────
-- Without these grants, Supabase Edge Functions using the auto-injected
-- SUPABASE_SERVICE_ROLE_KEY cannot query registry.companies (or any other
-- registry table) — they get "Company not found" because PostgREST returns
-- no rows when the role lacks USAGE on the schema.
-- Mirrors 032_grant_pramaana_schema_to_postgrest_roles.sql for the registry schema.

GRANT USAGE ON SCHEMA registry TO service_role;

GRANT SELECT ON registry.companies     TO service_role;
GRANT SELECT ON registry.company_users TO service_role;
GRANT SELECT ON registry.profiles      TO service_role;

-- Cover any future tables added to registry
ALTER DEFAULT PRIVILEGES IN SCHEMA registry
  GRANT SELECT ON TABLES TO service_role;
