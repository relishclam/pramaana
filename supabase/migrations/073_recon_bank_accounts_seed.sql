-- ── 073_recon_bank_accounts_seed.sql ─────────────────────────────────────────
-- Pre-seeds known Relish Group bank accounts into recon_bank_accounts so that
-- ledger_id is already linked before the first statement upload.
-- The upload API does an upsert on (company_id, bank_code, account_number),
-- so these rows will be found and reused — ledger_id will not be overwritten.
--
-- Company IDs (from spec):
--   RFPL  (Relish Foods Pvt Ltd)      : bc455c94-0bcd-4d66-a040-d29ed880d22f
--   RHHF  (Relish Hao Hao Chi Foods)  : b8beb440-df7f-48e8-a012-ac5750502eca
--
-- Ledger IDs (from pramaana.ledgers where is_bank_account = true):
--   866ef584  Canara Bank       0701201001375   → RFPL
--   788d9d89  Federal Bank      10150200014513  → RFPL
--   f631b55b  HDFC Bank         99999446012324  → RHHF current a/c
--   c4c1bed5  HDFC BANK ABM     50200115901702  → RHHF no-lien a/c
--   f9876b41  South Indian Bank (no account no) → RHHF
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO pramaana.recon_bank_accounts
  (company_id, bank_code, bank_name, account_number, account_type, ledger_id, currency)
VALUES
  -- RFPL accounts
  (
    'bc455c94-0bcd-4d66-a040-d29ed880d22f',
    'CANARA', 'Canara Bank', '0701201001375', 'current',
    '866ef584-18b3-47f8-9772-780e645f34f6', 'INR'
  ),
  (
    'bc455c94-0bcd-4d66-a040-d29ed880d22f',
    'FEDERAL', 'Federal Bank', '10150200014513', 'current',
    '788d9d89-1c29-420c-bbe7-fea4b782e227', 'INR'
  ),
  -- RHHF accounts
  (
    'b8beb440-df7f-48e8-a012-ac5750502eca',
    'HDFC', 'HDFC Bank', '99999446012324', 'current',
    'f631b55b-3552-4689-b2b9-1f426d8ac5d9', 'INR'
  ),
  (
    'b8beb440-df7f-48e8-a012-ac5750502eca',
    'HDFC', 'HDFC Bank', '50200115901702', 'savings',
    'c4c1bed5-3d42-4942-91c9-92abc72596a4', 'INR'
  ),
  (
    'b8beb440-df7f-48e8-a012-ac5750502eca',
    'SIB', 'South Indian Bank', 'UNKNOWN', 'current',
    'f9876b41-2fe5-4957-b897-eac51e6d155f', 'INR'
  )
ON CONFLICT (company_id, bank_code, account_number)
DO UPDATE SET
  ledger_id    = EXCLUDED.ledger_id,
  bank_name    = EXCLUDED.bank_name,
  account_type = EXCLUDED.account_type,
  updated_at   = now();
