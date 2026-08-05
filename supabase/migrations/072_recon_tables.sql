-- ── 072_recon_tables.sql ──────────────────────────────────────────────────────
-- Purpose : Autonomous Bank Reconciliation Module — new schema.
--           Replaces bank_format_config / bank_statements / bank_statement_lines
--           / bank_matches (old tables are NOT dropped here; cleanup is step 14).
--
-- Tables  : recon_bank_accounts, recon_format_profiles, recon_statements,
--           recon_transactions, recon_matches, recon_queries
-- RLS     : company-scoped via registry.company_users on every table
-- Storage : bank-recon-raw bucket (raw file storage for overlap re-parse)
-- Safe    : Idempotent — uses IF NOT EXISTS / DROP POLICY IF EXISTS throughout
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. recon_bank_accounts ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.recon_bank_accounts (
  id             uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid    NOT NULL,  -- no FK; pramaana schema has no companies table; RLS enforces scoping
  bank_code      text    NOT NULL,
  bank_name      text    NOT NULL,
  account_number text    NOT NULL,
  ifsc           text,
  branch         text,
  account_type   text,
  ledger_id      uuid    REFERENCES pramaana.ledgers(id),
  currency       text    NOT NULL DEFAULT 'INR',
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, bank_code, account_number)
);

ALTER TABLE pramaana.recon_bank_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rba_company_access ON pramaana.recon_bank_accounts;
CREATE POLICY rba_company_access ON pramaana.recon_bank_accounts
  FOR ALL
  USING (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      WHERE cu.user_id = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      WHERE cu.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS rba_service_all ON pramaana.recon_bank_accounts;
CREATE POLICY rba_service_all ON pramaana.recon_bank_accounts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 2. recon_format_profiles ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.recon_format_profiles (
  id               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_code        text    NOT NULL,
  format_signature text    NOT NULL,
  column_mapping   jsonb   NOT NULL,
  sample_headers   text[],
  detection_method text    NOT NULL DEFAULT 'heuristic'
                   CHECK (detection_method IN ('heuristic', 'ai')),
  times_used       integer NOT NULL DEFAULT 1,
  last_used_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_code, format_signature)
);

-- No RLS on format_profiles — not company-scoped, shared knowledge base
ALTER TABLE pramaana.recon_format_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rfp_authenticated_read ON pramaana.recon_format_profiles;
CREATE POLICY rfp_authenticated_read ON pramaana.recon_format_profiles
  FOR SELECT TO authenticated USING (true);

-- Format profile upserts (learning loop) are performed via the service_role client
-- in the upload API route — authenticated users get read-only access.
DROP POLICY IF EXISTS rfp_service_all ON pramaana.recon_format_profiles;
CREATE POLICY rfp_service_all ON pramaana.recon_format_profiles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 3. recon_statements ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.recon_statements (
  id                uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid    NOT NULL,  -- no FK; consistent with all other pramaana tables
  bank_account_id   uuid    NOT NULL REFERENCES pramaana.recon_bank_accounts(id),
  period_from       date    NOT NULL,
  period_to         date    NOT NULL,
  opening_balance   numeric(15,2) NOT NULL,
  closing_balance   numeric(15,2) NOT NULL,
  total_debits      numeric(15,2) NOT NULL DEFAULT 0,
  total_credits     numeric(15,2) NOT NULL DEFAULT 0,
  txn_count         integer NOT NULL DEFAULT 0,
  debit_count       integer NOT NULL DEFAULT 0,
  credit_count      integer NOT NULL DEFAULT 0,
  sort_order        text    NOT NULL DEFAULT 'asc'
                    CHECK (sort_order IN ('asc', 'desc')),
  format_profile_id uuid    REFERENCES pramaana.recon_format_profiles(id),
  file_name         text,
  file_hash         text,
  storage_path      text,   -- Supabase Storage path for re-parse on overlap resolution
  upload_status     text    NOT NULL DEFAULT 'processing'
                    CHECK (upload_status IN ('processing', 'pending_overlap', 'parsed', 'matched', 'error')),
  error_message     text,
  uploaded_by       uuid    REFERENCES auth.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT no_inverted_period CHECK (period_from <= period_to)
);

CREATE INDEX IF NOT EXISTS idx_recon_statements_bank_period
  ON pramaana.recon_statements (bank_account_id, period_from, period_to);

CREATE INDEX IF NOT EXISTS idx_recon_statements_company
  ON pramaana.recon_statements (company_id, upload_status);

CREATE INDEX IF NOT EXISTS idx_recon_statements_file_hash
  ON pramaana.recon_statements (company_id, file_hash);

ALTER TABLE pramaana.recon_statements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rs_company_access ON pramaana.recon_statements;
CREATE POLICY rs_company_access ON pramaana.recon_statements
  FOR ALL
  USING (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      WHERE cu.user_id = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      WHERE cu.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS rs_service_all ON pramaana.recon_statements;
CREATE POLICY rs_service_all ON pramaana.recon_statements
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 4. recon_transactions ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.recon_transactions (
  id                  uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id        uuid    NOT NULL REFERENCES pramaana.recon_statements(id) ON DELETE CASCADE,
  company_id          uuid    NOT NULL,
  bank_account_id     uuid    NOT NULL REFERENCES pramaana.recon_bank_accounts(id),
  row_number          integer NOT NULL,
  txn_date            date    NOT NULL,
  value_date          date,
  narration           text    NOT NULL,
  reference           text,
  debit               numeric(15,2),
  credit              numeric(15,2),
  balance             numeric(15,2) NOT NULL,
  -- Parsed narration enrichment (heuristic or AI)
  txn_type            text,
  counterparty        text,
  counterparty_account text,
  parsed_reference    text,
  parsed_purpose      text,
  is_charge           boolean NOT NULL DEFAULT false,
  is_reversal         boolean NOT NULL DEFAULT false,
  -- Match state
  match_status        text    NOT NULL DEFAULT 'unmatched'
                      CHECK (match_status IN (
                        'unmatched', 'pending_review', 'auto_matched', 'manual_matched',
                        'disputed', 'written_off'
                      )),
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- Core integrity: every row is exactly a debit OR a credit, never both, never neither
  CONSTRAINT exactly_one_side CHECK (
    (debit IS NOT NULL AND credit IS NULL) OR
    (debit IS NULL AND credit IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_recon_txn_match
  ON pramaana.recon_transactions (bank_account_id, match_status);

CREATE INDEX IF NOT EXISTS idx_recon_txn_date
  ON pramaana.recon_transactions (bank_account_id, txn_date);

CREATE INDEX IF NOT EXISTS idx_recon_txn_amount
  ON pramaana.recon_transactions (bank_account_id, debit, credit);

CREATE INDEX IF NOT EXISTS idx_recon_txn_statement
  ON pramaana.recon_transactions (statement_id, row_number);

ALTER TABLE pramaana.recon_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rt_company_access ON pramaana.recon_transactions;
CREATE POLICY rt_company_access ON pramaana.recon_transactions
  FOR ALL
  USING (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      WHERE cu.user_id = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      WHERE cu.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS rt_service_all ON pramaana.recon_transactions;
CREATE POLICY rt_service_all ON pramaana.recon_transactions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 5. recon_matches ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.recon_matches (
  id                uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid    NOT NULL,
  bank_txn_id       uuid    NOT NULL REFERENCES pramaana.recon_transactions(id) ON DELETE CASCADE,
  voucher_id        uuid    REFERENCES pramaana.vouchers(id),
  voucher_entry_id  uuid    REFERENCES pramaana.voucher_entries(id),
  match_method      text    NOT NULL
                    CHECK (match_method IN ('exact', 'reference', 'fuzzy', 'ai', 'manual')),
  match_confidence  numeric(5,2),
  match_reason      text,
  matched_by        uuid    REFERENCES auth.users(id),
  matched_at        timestamptz NOT NULL DEFAULT now(),
  is_confirmed      boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- One bank transaction → at most one voucher match
  UNIQUE (bank_txn_id)
);

CREATE INDEX IF NOT EXISTS idx_recon_matches_voucher
  ON pramaana.recon_matches (voucher_id);

CREATE INDEX IF NOT EXISTS idx_recon_matches_company
  ON pramaana.recon_matches (company_id, is_confirmed);

ALTER TABLE pramaana.recon_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rm_company_access ON pramaana.recon_matches;
CREATE POLICY rm_company_access ON pramaana.recon_matches
  FOR ALL
  USING (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      WHERE cu.user_id = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      WHERE cu.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS rm_service_all ON pramaana.recon_matches;
CREATE POLICY rm_service_all ON pramaana.recon_matches
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 6. recon_queries ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.recon_queries (
  id                    uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid    NOT NULL,
  bank_txn_id           uuid    REFERENCES pramaana.recon_transactions(id),
  voucher_id            uuid    REFERENCES pramaana.vouchers(id),
  query_type            text    NOT NULL
                        CHECK (query_type IN (
                          'bank_orphan', 'book_orphan',
                          'amount_mismatch', 'date_mismatch', 'duplicate_suspect'
                        )),
  status                text    NOT NULL DEFAULT 'open'
                        CHECK (status IN (
                          'open', 'investigating', 'resolved', 'written_off', 'adjusted'
                        )),
  resolution_note       text,
  resolution_voucher_id uuid    REFERENCES pramaana.vouchers(id),
  assigned_to           uuid    REFERENCES auth.users(id),
  resolved_by           uuid    REFERENCES auth.users(id),
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recon_queries_company
  ON pramaana.recon_queries (company_id, status);

CREATE INDEX IF NOT EXISTS idx_recon_queries_txn
  ON pramaana.recon_queries (bank_txn_id);

ALTER TABLE pramaana.recon_queries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rq_company_access ON pramaana.recon_queries;
CREATE POLICY rq_company_access ON pramaana.recon_queries
  FOR ALL
  USING (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      WHERE cu.user_id = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      WHERE cu.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS rq_service_all ON pramaana.recon_queries;
CREATE POLICY rq_service_all ON pramaana.recon_queries
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 7. Shared updated_at trigger function ───────────────────────────────────
-- Used by recon_bank_accounts, recon_statements, recon_queries

CREATE OR REPLACE FUNCTION pramaana.recon_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_updated_at ON pramaana.recon_bank_accounts;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON pramaana.recon_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION pramaana.recon_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON pramaana.recon_statements;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON pramaana.recon_statements
  FOR EACH ROW EXECUTE FUNCTION pramaana.recon_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON pramaana.recon_queries;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON pramaana.recon_queries
  FOR EACH ROW EXECUTE FUNCTION pramaana.recon_set_updated_at();

-- ── 8. Storage bucket for raw file re-parse ───────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'bank-recon-raw',
  'bank-recon-raw',
  false,
  20971520,  -- 20 MB
  ARRAY[
    'text/csv', 'text/plain', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- All storage operations (upload + re-parse) use the service_role client in API routes.
-- No authenticated-user storage policy is needed; raw files are internal artifacts.
DROP POLICY IF EXISTS "bank_recon_raw_service" ON storage.objects;
CREATE POLICY "bank_recon_raw_service" ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'bank-recon-raw')
  WITH CHECK (bucket_id = 'bank-recon-raw');
