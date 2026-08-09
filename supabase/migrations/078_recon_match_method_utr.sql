-- ── 078_recon_match_method_utr.sql ───────────────────────────────────────────
--
-- PURPOSE
--   Add 'utr' as an allowed value in recon_matches.match_method.
--
-- EXISTING constraint (from 075_recon_match_method_reference.sql):
--   CHECK (match_method IN ('exact', 'reference', 'fuzzy', 'ai', 'manual'))
--
-- NEW constraint:
--   CHECK (match_method IN ('exact', 'reference', 'fuzzy', 'ai', 'manual', 'utr'))
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pramaana.recon_matches
  DROP CONSTRAINT recon_matches_match_method_check;

ALTER TABLE pramaana.recon_matches
  ADD CONSTRAINT recon_matches_match_method_check
  CHECK (match_method IN ('exact', 'reference', 'fuzzy', 'ai', 'manual', 'utr'));
