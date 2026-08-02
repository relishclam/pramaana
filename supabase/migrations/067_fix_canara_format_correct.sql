-- ── 067_fix_bank_format_configs.sql ─────────────────────────────────────────
-- CANARA: Migration 066 set wrong column_map (PDF headers) and skip_footer_rows=1.
--   Actual file: Canara net-banking CSV
--   Actual headers: Txn Date, Value Date, Cheque No., Description, Debit, Credit, Balance
--   Actual date format: "01 Apr 2024 07:05:00"  (dd MMM yyyy HH:mm:ss)
--   No footer rows (empty last line is skipped by parser automatically)
--
-- FEDERAL: Original seed config is already correct but documenting here for clarity.
--   Actual file: Federal Bank net-banking CSV (.csv.xls extension, plain CSV)
--   Actual headers: Sl. No., Tran Date, Particulars, (empty), Value Date, Tran Type,
--                   Cheque Details, Withdrawal, Deposit, Balance Amount
--   Actual date format: "31-07-2026"  (DD-MM-YYYY)
--   Footer row = disclaimer text ("This is a computer generated...") — fails date
--   parse silently, skip_footer_rows=0 is fine.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE pramaana.bank_format_config
SET
  column_map = '{
    "date":       "Txn Date",
    "value_date": "Value Date",
    "narration":  "Description",
    "ref":        "Cheque No.",
    "debit":      "Debit",
    "credit":     "Credit",
    "balance":    "Balance"
  }'::jsonb,
  date_format      = 'DD MMM YYYY HH:mm:ss',
  header_row       = 1,
  skip_footer_rows = 0
WHERE bank_code = 'CANARA';

-- Federal config is correct from migration 062; re-assert to be safe
UPDATE pramaana.bank_format_config
SET
  column_map = '{
    "date":       "Tran Date",
    "value_date": "Value Date",
    "narration":  "Particulars",
    "ref":        "Cheque Details",
    "debit":      "Withdrawal",
    "credit":     "Deposit",
    "balance":    "Balance Amount"
  }'::jsonb,
  date_format      = 'DD-MM-YYYY',
  header_row       = 1,
  skip_footer_rows = 0
WHERE bank_code = 'FEDERAL';

