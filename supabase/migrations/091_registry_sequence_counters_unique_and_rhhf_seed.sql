-- ════════════════════════════════════════════════════════════════════════════
-- 091_registry_sequence_counters_unique_and_rhhf_seed.sql
--
-- Problem: registry.next_fy_sequence uses ON CONFLICT (company_id, prefix, year)
-- but registry.sequence_counters has no matching unique constraint, so every
-- INSERT from the function raises:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
-- This is a both-company outage: every new voucher creation fails.
--
-- Note: the diagnostic queries that led to this migration searched only the
-- pramaana and public schemas, so they found public.sequence_counters (a
-- different Suite-era table) and missed registry.sequence_counters entirely.
-- The function's ON CONFLICT clause is already correct — the constraint is
-- the missing piece.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Step 1: Remove duplicates keeping the highest counter per scope ──────────
-- Required before adding the unique constraint (duplicate rows would block it).
DELETE FROM registry.sequence_counters
WHERE id NOT IN (
  SELECT DISTINCT ON (company_id, prefix, year)
         id
  FROM   registry.sequence_counters
  ORDER  BY company_id, prefix, year, last_number DESC
);

-- ── Step 2: Add the unique constraint if it doesn't already exist ─────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint c
    JOIN   pg_class      t ON t.oid = c.conrelid
    JOIN   pg_namespace  n ON n.oid = t.relnamespace
    WHERE  n.nspname = 'registry'
    AND    t.relname = 'sequence_counters'
    AND    c.contype = 'u'
    AND    array_to_string(
             ARRAY(SELECT a.attname
                   FROM   pg_attribute a
                   WHERE  a.attrelid = t.oid
                   AND    a.attnum = ANY(c.conkey)
                   ORDER  BY a.attnum), ',')
           = 'company_id,prefix,year'
  ) THEN
    ALTER TABLE registry.sequence_counters
      ADD CONSTRAINT sequence_counters_company_prefix_year_uq
      UNIQUE (company_id, prefix, year);
  END IF;
END $$;

-- ── Step 3: Seed RHHF VCH counter — continues from Relish Approvals ~729 ─────
-- year 2627 = FY 2026-27 (function encodes Apr 2026–Mar 2027 as integer 2627)
INSERT INTO registry.sequence_counters (id, company_id, prefix, year, last_number)
VALUES (
  gen_random_uuid(),
  'b8beb440-df7f-48e8-a012-ac5750502eca',
  'VCH',
  2627,
  729
)
ON CONFLICT (company_id, prefix, year)
DO UPDATE SET last_number = GREATEST(registry.sequence_counters.last_number, 729);
