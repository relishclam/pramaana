-- ════════════════════════════════════════════════════════════════════════════
-- 083_retire_public_user_companies.sql
-- Drop the dead public.user_companies table.
-- Zero code references confirmed (grep across all .sql/.ts/.tsx/.py clean).
-- Safe: IF EXISTS — no-op if already absent.
-- ════════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS public.user_companies CASCADE;
