-- ── Grant write access on registry.profiles to service_role ─────────────────
-- Migration 051 granted SELECT only.
-- The invite-user Edge Function needs INSERT + UPDATE to bootstrap a profile
-- row after calling auth.admin.inviteUserByEmail(), so that the invited user
-- can log in without hitting "Profile not found" on first sign-in.
--
-- Safe: GRANT is idempotent — re-running does not error.

GRANT INSERT, UPDATE ON registry.profiles TO service_role;
