-- 037_profile_mobile.sql
-- Add mobile + entity_id to registry.profiles so Pramaana can store
-- admin contact details natively (instead of relying on public.profiles.phone).

ALTER TABLE registry.profiles
  ADD COLUMN IF NOT EXISTS mobile      TEXT,
  ADD COLUMN IF NOT EXISTS entity_id   UUID REFERENCES registry.entities(id);

-- Seed mobile from public.profiles.phone for any user already in both systems
-- (safe to run repeatedly — only fills null rows from non-null sources).
UPDATE registry.profiles rp
SET    mobile = pp.phone
FROM   public.profiles pp
WHERE  rp.id   = pp.id
  AND  pp.phone IS NOT NULL
  AND  rp.mobile IS NULL;
