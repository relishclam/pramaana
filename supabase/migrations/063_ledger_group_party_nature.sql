-- ── 063_ledger_group_party_nature.sql ───────────────────────────────────────
-- Purpose : Add is_party_nature flag to pramaana.ledger_groups.
--           Party-nature groups are those whose ledgers represent counterparties
--           (customers, vendors, staff) rather than accounts or heads.
--           Used by the ledger form to decide whether an Entity Link is required.
--
-- Data migration: set true for the obvious party groups by name pattern.
--                 Admin can adjust via Ledger Groups tab if needed.
-- Safe    : Idempotent — ADD COLUMN IF NOT EXISTS, safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pramaana.ledger_groups
  ADD COLUMN IF NOT EXISTS is_party_nature boolean NOT NULL DEFAULT false;

-- Set true for groups whose names match common party-group patterns
UPDATE pramaana.ledger_groups
SET    is_party_nature = true
WHERE  LOWER(name) SIMILAR TO
       '%sundry debtor%|%sundry creditor%|%loans & advances%|%loans and advances%|%staff%|%salary%|%director%|%partner%|%shareholder%';

COMMENT ON COLUMN pramaana.ledger_groups.is_party_nature IS
  'True for groups whose ledgers represent counterparties (debtors, creditors, staff). '
  'Controls whether the Entity Link field is shown/required on the ledger form.';
