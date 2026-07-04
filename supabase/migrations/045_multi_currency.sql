-- ── Multi-Currency / FX Support ─────────────────────────────────────────────
-- Migration: 045_multi_currency.sql
-- Purpose: Add foreign currency support to vouchers and voucher entries.
--
-- Design:
--   pramaana.vouchers.currency       — ISO 4217 code (e.g. 'INR', 'HKD', 'JPY')
--   pramaana.vouchers.exchange_rate  — INR per 1 unit of currency on the invoice date
--                                      (RBI reference rate, entered manually)
--   pramaana.voucher_entries.foreign_amount — amount in the original invoice currency.
--                                             NULL for INR-denominated entries.
--
-- Invariant:
--   voucher_entries.amount is ALWAYS stored in INR.
--   For FX entries: amount = round(foreign_amount × exchange_rate, 2)
--   For INR entries: amount = entered amount, foreign_amount = NULL.
--
-- This means ALL existing report queries (Trial Balance, P&L, Balance Sheet,
-- Day Book, Receivables/Payables) continue working without modification — they
-- all read voucher_entries.amount which is always INR.
--
-- Backward compatible: all existing rows get DEFAULT values.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pramaana.vouchers
  ADD COLUMN IF NOT EXISTS currency      TEXT          NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(14,6) NOT NULL DEFAULT 1.000000;

ALTER TABLE pramaana.voucher_entries
  ADD COLUMN IF NOT EXISTS foreign_amount NUMERIC(15,2);

-- Sanity check: exchange rate must always be positive
ALTER TABLE pramaana.vouchers
  DROP CONSTRAINT IF EXISTS chk_exchange_rate_positive;

ALTER TABLE pramaana.vouchers
  ADD CONSTRAINT chk_exchange_rate_positive
  CHECK (exchange_rate > 0);

-- Informational comments
COMMENT ON COLUMN pramaana.vouchers.currency IS
  'ISO 4217 currency code for this voucher. Default INR. '
  'For foreign-currency vouchers all entry amounts are stored as INR equivalents '
  '(foreign_amount × exchange_rate, rounded to 2 dp).';

COMMENT ON COLUMN pramaana.vouchers.exchange_rate IS
  'RBI reference rate: INR per 1 unit of the voucher currency on the invoice date. '
  'Always 1.000000 for INR vouchers. '
  'Example: 1 HKD = 10.55 INR → exchange_rate = 10.550000.';

COMMENT ON COLUMN pramaana.voucher_entries.foreign_amount IS
  'Amount in the voucher''s original currency. NULL for INR entries. '
  'INR equivalent = foreign_amount × exchange_rate and is stored in the amount column.';

-- Grant access to PostgREST roles (schema already granted; no new tables)
-- No additional grants needed — columns inherit table-level RLS.
