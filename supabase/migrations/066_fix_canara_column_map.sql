-- ── 066_fix_canara_column_map.sql ────────────────────────────────────────────
-- Problem : CANARA bank_format_config was seeded with net-banking CSV column
--           names ("Txn Date", "Debit", "Credit", …).  Production files are
--           Adobe-extracted PDFs whose printed headers differ:
--             "Date", "Narration", "Chq/Ref Number",
--             "Withdrawal (Dr.)", "Deposit (Cr.)", "Balance (Rs.)"
--           The parser now auto-resolves via COL_ALIASES (bank-parse.ts),
--           but this migration corrects the canonical config so it acts as
--           authoritative documentation and avoids alias-lookup overhead.
-- Safe    : UPDATE with WHERE bank_code = 'CANARA'. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE pramaana.bank_format_config
SET
  column_map = '{
    "date":       "Date",
    "value_date": "Value Date",
    "narration":  "Narration",
    "ref":        "Chq/Ref Number",
    "debit":      "Withdrawal (Dr.)",
    "credit":     "Deposit (Cr.)",
    "balance":    "Balance (Rs.)"
  }'::jsonb,
  -- PDF statements print DD/MM/YYYY; parser now has multi-format fallback anyway
  date_format      = 'DD/MM/YYYY',
  -- PDF table extraction starts with the header row; no pre-table metadata rows
  header_row       = 1,
  -- Canara PDFs often end with a totals / "End of Statement" line
  skip_footer_rows = 1
WHERE bank_code = 'CANARA';
