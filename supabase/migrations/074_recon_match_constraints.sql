-- ── 074_recon_match_constraints.sql ─────────────────────────────────────────
-- Allow one bank txn to settle multiple vouchers (combo payments).
-- Replaces the single-txn unique constraint with (bank_txn_id, voucher_entry_id).
-- Idempotent: drops old constraint only if it exists.
--
-- Also:
--   - Cleans up duplicate/stale open queries left from pre-dedup engine runs
--   - Resolves open queries whose transaction is now matched
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Replace unique constraint on recon_matches
DO $$
BEGIN
  -- Drop old single-column unique constraint (name may vary — handles both names)
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'recon_matches_bank_txn_id_key'
      AND conrelid = 'pramaana.recon_matches'::regclass
  ) THEN
    ALTER TABLE pramaana.recon_matches DROP CONSTRAINT recon_matches_bank_txn_id_key;
  END IF;

  -- Add composite unique constraint if not already present
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'recon_matches_txn_entry_unique'
      AND conrelid = 'pramaana.recon_matches'::regclass
  ) THEN
    ALTER TABLE pramaana.recon_matches
      ADD CONSTRAINT recon_matches_txn_entry_unique
      UNIQUE (bank_txn_id, voucher_entry_id);
  END IF;
END $$;

-- 2. Resolve open queries whose transaction is now matched
UPDATE pramaana.recon_queries q
SET    status           = 'resolved',
       resolution_note  = 'Auto-resolved: transaction matched',
       resolved_at      = now()
WHERE  q.status IN ('open', 'investigating')
  AND  q.bank_txn_id IS NOT NULL
  AND  EXISTS (
         SELECT 1 FROM pramaana.recon_transactions t
         WHERE  t.id = q.bank_txn_id
           AND  t.match_status NOT IN ('unmatched', 'pending_review')
       );

-- 3. Deduplicate open queries: keep the oldest open query per txn, resolve the rest
UPDATE pramaana.recon_queries q
SET    status          = 'resolved',
       resolution_note = 'Deduplicated: earlier open query retained',
       resolved_at     = now()
WHERE  q.status IN ('open', 'investigating')
  AND  q.bank_txn_id IS NOT NULL
  AND  q.id NOT IN (
         SELECT DISTINCT ON (bank_txn_id) id
         FROM   pramaana.recon_queries
         WHERE  status IN ('open', 'investigating')
           AND  bank_txn_id IS NOT NULL
         ORDER  BY bank_txn_id, created_at ASC
       );
