-- ── Grant PostgREST role access to pramaana schema ───────────────────────────
-- Without these grants, the Vercel edge functions using the service_role key
-- get "permission denied for schema pramaana" even though pramaana is in the
-- Supabase Data API exposed schemas list.
-- Run once in Supabase SQL Editor, then keep as a migration record.

GRANT USAGE ON SCHEMA pramaana TO anon, authenticated, service_role;

GRANT ALL ON ALL TABLES    IN SCHEMA pramaana TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pramaana TO service_role;
GRANT ALL ON ALL ROUTINES  IN SCHEMA pramaana TO service_role;

-- authenticated role needs SELECT on settlement_sessions for token validation
GRANT SELECT ON pramaana.settlement_sessions TO authenticated;

-- Ensure future tables in the schema are also covered
ALTER DEFAULT PRIVILEGES IN SCHEMA pramaana
  GRANT ALL ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA pramaana
  GRANT ALL ON SEQUENCES TO service_role;
