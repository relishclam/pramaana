-- ── 035_suspense_submitted_by.sql ────────────────────────────────────────────
-- Adds submitted_by to suspense_settlements for audit traceability.
-- NULL = submitted by staff via the public link (anon).
-- UUID = accounts/admin user who entered directly inside the register.

ALTER TABLE pramaana.suspense_settlements
  ADD COLUMN IF NOT EXISTS submitted_by UUID;

COMMENT ON COLUMN pramaana.suspense_settlements.submitted_by IS
  'Auth user ID of the accounts staff who submitted the entry directly (NULL for staff via public settlement link).';
