-- ====================================================================
-- PRAMAANA CLEANUP: Delete all pre-migration trial data
-- ====================================================================
--
-- PURPOSE : Remove all test/trial vouchers and orphaned ledgers that
--           existed in Pramaana BEFORE the Relish Approvals migration.
--
-- SAFE    : The migrated data (voucher_number LIKE 'VCH-2026-27-%')
--           is never touched.  System ledger groups (company_id IS NULL)
--           are never touched.
--
-- HOW TO USE:
--   STEP 1 : Run SECTION A (preview) — confirm counts look right
--   STEP 2 : Run SECTION B (delete) — order matters; run top to bottom
--
-- Run in: Pramaana Supabase (mmkbknnzgpvsqgnynrbe) → SQL Editor
-- ====================================================================

-- ════════════════════════════════════════════════════════════════════
-- SECTION A — PREVIEW  (read-only, run this first)
-- ════════════════════════════════════════════════════════════════════

-- A1. Count trial vouchers that will be deleted
SELECT
  c.code,
  COUNT(*)                                                             AS trial_vouchers,
  LEFT(STRING_AGG(v.voucher_number, ', ' ORDER BY v.created_at), 500) AS sample_numbers
FROM pramaana.vouchers v
JOIN registry.companies c ON c.id = v.company_id
WHERE c.code IN ('RFPL', 'RHHF')
  AND v.voucher_number NOT LIKE 'VCH-2026-27-%'
GROUP BY c.code;

-- A2. Count migrated vouchers that will be KEPT (sanity check — should be ~602)
SELECT
  c.code,
  COUNT(*) AS migrated_vouchers_kept
FROM pramaana.vouchers v
JOIN registry.companies c ON c.id = v.company_id
WHERE c.code IN ('RFPL', 'RHHF')
  AND v.voucher_number LIKE 'VCH-2026-27-%'
GROUP BY c.code;

-- A3. Orphaned ledgers that will be deleted (no voucher entries after cleanup)
-- These are ledgers with zero entries that are not is_system.
-- Run AFTER the voucher delete to see final state — or use subquery below:
SELECT
  c.code,
  l.name                        AS orphan_ledger,
  lg.name                       AS group_name
FROM pramaana.ledgers l
JOIN registry.companies c ON c.id = l.company_id
JOIN pramaana.ledger_groups lg ON lg.id = l.group_id
WHERE c.code IN ('RFPL', 'RHHF')
  AND l.is_system = false
  AND l.id NOT IN (
    -- entries that survive (belong to migrated vouchers)
    SELECT ve.ledger_id
    FROM pramaana.voucher_entries ve
    JOIN pramaana.vouchers v ON v.id = ve.voucher_id
    WHERE v.voucher_number LIKE 'VCH-2026-27-%'
  )
ORDER BY c.code, lg.name, l.name;


-- ════════════════════════════════════════════════════════════════════
-- SECTION B — DELETE  (run each statement individually, in order)
-- ════════════════════════════════════════════════════════════════════

-- B1. Delete trial vouchers
--     ON DELETE CASCADE removes their voucher_entries automatically.
--     session_replication_role = replica bypasses user-defined triggers
--     (including fn_prevent_posted_edit) without touching FK system triggers.
SET session_replication_role = replica;

DELETE FROM pramaana.vouchers
WHERE company_id IN (
    SELECT id FROM registry.companies WHERE code IN ('RFPL', 'RHHF')
  )
  AND voucher_number NOT LIKE 'VCH-2026-27-%';

SET session_replication_role = DEFAULT;

-- B2. Delete ledgers that now have no voucher entries and are not system ledgers.
--     (Entries from trial vouchers are already gone via cascade above.)
DELETE FROM pramaana.ledgers
WHERE company_id IN (
    SELECT id FROM registry.companies WHERE code IN ('RFPL', 'RHHF')
  )
  AND is_system = false
  AND id NOT IN (
    SELECT DISTINCT ledger_id FROM pramaana.voucher_entries
  );

-- B3. Delete ledger groups (company-specific) that now have no child ledgers.
DELETE FROM pramaana.ledger_groups
WHERE company_id IN (
    SELECT id FROM registry.companies WHERE code IN ('RFPL', 'RHHF')
  )
  AND id NOT IN (
    SELECT DISTINCT group_id
    FROM pramaana.ledgers
    WHERE company_id IN (
      SELECT id FROM registry.companies WHERE code IN ('RFPL', 'RHHF')
    )
  );

-- ── Verification after cleanup ────────────────────────────────────────────────
SELECT
  c.code,
  COUNT(DISTINCT v.id)    AS vouchers,
  COUNT(ve.id)            AS entries,
  SUM(ve.amount)          AS total_amount
FROM pramaana.vouchers v
JOIN registry.companies c       ON c.id = v.company_id
JOIN pramaana.voucher_entries ve ON ve.voucher_id = v.id
WHERE c.code IN ('RFPL', 'RHHF')
GROUP BY c.code;
