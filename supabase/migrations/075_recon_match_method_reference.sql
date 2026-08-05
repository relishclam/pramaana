-- Add 'reference' to recon_matches.match_method check constraint
ALTER TABLE pramaana.recon_matches
  DROP CONSTRAINT recon_matches_match_method_check;

ALTER TABLE pramaana.recon_matches
  ADD CONSTRAINT recon_matches_match_method_check
  CHECK (match_method IN ('exact', 'reference', 'fuzzy', 'ai', 'manual'));
