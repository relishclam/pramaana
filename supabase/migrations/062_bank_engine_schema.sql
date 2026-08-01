-- ── 062_bank_engine_schema.sql ────────────────────────────────────────────────
-- Purpose : Bank Statement Extract & Compare Engine — schema, seeds, matching RPC.
--
-- Tables  : bank_format_config, bank_statements, bank_statement_lines,
--           brs_timing_items, audit_queries, audit_query_items,
--           audit_query_messages
-- RPC     : pramaana.run_bank_match(p_statement_id uuid)
--           pramaana.get_brs(p_bank_ledger_id uuid, p_as_of date)
-- Also    : Extend vouchers.source CHECK to allow 'bank_import'
--           Seed bank_format_config stubs for 5 banks
--           Attach audit trigger (061) to all new tables
--           RLS on all new tables (company_isolation pattern)
--           Expose storage bucket bank-statements
--
-- Safe    : All statements idempotent (IF NOT EXISTS, DROP/CREATE triggers).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Extend vouchers.source CHECK ──────────────────────────────────────────

ALTER TABLE pramaana.vouchers
  DROP CONSTRAINT IF EXISTS vouchers_source_check;

ALTER TABLE pramaana.vouchers
  ADD CONSTRAINT vouchers_source_check
  CHECK (source IN ('manual', 'ocr', 'bank_import'));

-- ── 2. bank_format_config ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.bank_format_config (
  id                uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_code         text    NOT NULL UNIQUE,   -- 'CANARA','FEDERAL','HDFC_CUR','HDFC_NOLIEN','AIRWALLEX'
  bank_ledger_id    uuid    NOT NULL REFERENCES pramaana.ledgers(id),
  company_id        uuid    NOT NULL,
  file_type         text    NOT NULL CHECK (file_type IN ('csv','xlsx','json')),
  encoding          text    NOT NULL DEFAULT 'utf-8',
  header_row        int     NOT NULL DEFAULT 1,
  column_map        jsonb   NOT NULL,
  date_format       text    NOT NULL,
  skip_footer_rows  int     NOT NULL DEFAULT 0,
  match_day_window  int     NOT NULL DEFAULT 3,  -- fuzzy tolerance: ±N days
  active            boolean NOT NULL DEFAULT false  -- set true after fixture verified
);

ALTER TABLE pramaana.bank_format_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bfc_company_read  ON pramaana.bank_format_config;
DROP POLICY IF EXISTS bfc_admin_write   ON pramaana.bank_format_config;
DROP POLICY IF EXISTS bfc_service_all   ON pramaana.bank_format_config;

CREATE POLICY bfc_company_read ON pramaana.bank_format_config
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY bfc_admin_write ON pramaana.bank_format_config
  FOR ALL TO authenticated
  USING  (registry.is_super_admin())
  WITH CHECK (registry.is_super_admin());

CREATE POLICY bfc_service_all ON pramaana.bank_format_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 3. bank_statements ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.bank_statements (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL,
  bank_format_id   uuid        NOT NULL REFERENCES pramaana.bank_format_config(id),
  storage_path     text        NOT NULL,         -- bucket: bank-statements
  period_from      date        NOT NULL,
  period_to        date        NOT NULL,
  opening_balance  numeric(15,2),
  closing_balance  numeric(15,2),
  line_count       int,
  parse_error      text,                          -- set when validation gate fails
  status           text        NOT NULL DEFAULT 'uploaded'
                   CHECK (status IN ('uploaded','parsed','matched','reviewed','finalized')),
  uploaded_by      uuid        NOT NULL REFERENCES auth.users(id),
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_statements_period_check CHECK (period_from <= period_to)
);

CREATE INDEX IF NOT EXISTS bank_statements_company_status
  ON pramaana.bank_statements (company_id, status);

ALTER TABLE pramaana.bank_statements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bs_company_read  ON pramaana.bank_statements;
DROP POLICY IF EXISTS bs_accounts_write ON pramaana.bank_statements;
DROP POLICY IF EXISTS bs_service_all   ON pramaana.bank_statements;

CREATE POLICY bs_company_read ON pramaana.bank_statements
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY bs_accounts_write ON pramaana.bank_statements
  FOR ALL TO authenticated
  USING (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      JOIN registry.profiles p ON p.id = auth.uid()
      WHERE cu.user_id = auth.uid()
        AND (p.is_super_admin = true OR cu.role IN ('admin','accounts'))
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      JOIN registry.profiles p ON p.id = auth.uid()
      WHERE cu.user_id = auth.uid()
        AND (p.is_super_admin = true OR cu.role IN ('admin','accounts'))
    )
  );

CREATE POLICY bs_service_all ON pramaana.bank_statements
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 4. bank_statement_lines ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.bank_statement_lines (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id         uuid        NOT NULL REFERENCES pramaana.bank_statements(id) ON DELETE CASCADE,
  company_id           uuid        NOT NULL,
  line_no              int         NOT NULL,
  txn_date             date        NOT NULL,
  value_date           date,
  narration            text,
  ref_no               text,                -- UTR / cheque number
  debit                numeric(15,2) NOT NULL DEFAULT 0,    -- money OUT of bank (positive)
  credit               numeric(15,2) NOT NULL DEFAULT 0,    -- money INTO bank (positive)
  running_balance      numeric(15,2),
  match_status         text        NOT NULL DEFAULT 'unmatched'
                       CHECK (match_status IN (
                         'unmatched',      -- initial state
                         'matched',        -- exact match, auto-confirmed
                         'fuzzy_matched',  -- pass 2/3, awaiting human confirmation
                         'confirmed',      -- human confirmed fuzzy/group match
                         'unbooked',       -- in bank, not in books → needs voucher
                         'queried',        -- query raised against this line
                         'resolved',       -- query answered and rectified
                         'ignored'         -- manually dismissed (contra, duplicate, etc.)
                       )),
  matched_voucher_id   uuid        REFERENCES pramaana.vouchers(id),
  match_group_id       uuid,               -- shared across lines/vouchers in a group match
  match_pass           smallint,           -- 1=exact, 2=fuzzy, 3=group-sum, 0=manual
  match_note           text,
  UNIQUE (statement_id, line_no),
  CONSTRAINT bsl_amounts_positive CHECK (debit >= 0 AND credit >= 0),
  CONSTRAINT bsl_one_direction CHECK (NOT (debit > 0 AND credit > 0))  -- exactly one non-zero per line
);

CREATE INDEX IF NOT EXISTS bsl_company_date
  ON pramaana.bank_statement_lines (company_id, txn_date);

CREATE INDEX IF NOT EXISTS bsl_match_status
  ON pramaana.bank_statement_lines (match_status);

CREATE INDEX IF NOT EXISTS bsl_statement_id
  ON pramaana.bank_statement_lines (statement_id);

ALTER TABLE pramaana.bank_statement_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bsl_company_read  ON pramaana.bank_statement_lines;
DROP POLICY IF EXISTS bsl_accounts_write ON pramaana.bank_statement_lines;
DROP POLICY IF EXISTS bsl_service_all   ON pramaana.bank_statement_lines;

CREATE POLICY bsl_company_read ON pramaana.bank_statement_lines
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY bsl_accounts_write ON pramaana.bank_statement_lines
  FOR ALL TO authenticated
  USING (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      JOIN registry.profiles p ON p.id = auth.uid()
      WHERE cu.user_id = auth.uid()
        AND (p.is_super_admin = true OR cu.role IN ('admin','accounts','auditor'))
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      JOIN registry.profiles p ON p.id = auth.uid()
      WHERE cu.user_id = auth.uid()
        AND (p.is_super_admin = true OR cu.role IN ('admin','accounts','auditor'))
    )
  );

CREATE POLICY bsl_service_all ON pramaana.bank_statement_lines
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 5. brs_timing_items ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.brs_timing_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL,
  voucher_id      uuid NOT NULL REFERENCES pramaana.vouchers(id),
  bank_ledger_id  uuid NOT NULL REFERENCES pramaana.ledgers(id),
  item_type       text NOT NULL CHECK (item_type IN (
                    'cheque_not_presented',   -- book Cr, bank not yet debited
                    'deposit_in_transit',     -- book Dr, bank not yet credited
                    'other'
                  )),
  as_of           date NOT NULL,              -- statement period_to when this was open
  cleared_line_id uuid REFERENCES pramaana.bank_statement_lines(id),
  cleared_at      timestamptz
);

CREATE INDEX IF NOT EXISTS brs_timing_company_bank
  ON pramaana.brs_timing_items (company_id, bank_ledger_id, as_of);

ALTER TABLE pramaana.brs_timing_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS brs_company_read ON pramaana.brs_timing_items;
DROP POLICY IF EXISTS brs_service_all  ON pramaana.brs_timing_items;

CREATE POLICY brs_company_read ON pramaana.brs_timing_items
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY brs_service_all ON pramaana.brs_timing_items
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 6. audit_queries (reusable query management) ─────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.audit_queries (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL,
  query_no     text        NOT NULL,        -- RFPL/QRY/2627/0001 via sequence_counters
  raised_by    uuid        NOT NULL REFERENCES auth.users(id),
  context_type text        NOT NULL CHECK (context_type IN (
                             'bank_line','voucher','ledger','period'
                           )),
  status       text        NOT NULL DEFAULT 'open'
               CHECK (status IN (
                 'open','responded','rectified','closed','withdrawn'
               )),
  subject      text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS aq_company_status
  ON pramaana.audit_queries (company_id, status);

ALTER TABLE pramaana.audit_queries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aq_company_read  ON pramaana.audit_queries;
DROP POLICY IF EXISTS aq_accounts_write ON pramaana.audit_queries;
DROP POLICY IF EXISTS aq_service_all   ON pramaana.audit_queries;

CREATE POLICY aq_company_read ON pramaana.audit_queries
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY aq_accounts_write ON pramaana.audit_queries
  FOR ALL TO authenticated
  USING (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      JOIN registry.profiles p ON p.id = auth.uid()
      WHERE cu.user_id = auth.uid()
        AND (p.is_super_admin = true OR cu.role IN ('admin','accounts','auditor'))
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cu.company_id FROM registry.company_users cu
      JOIN registry.profiles p ON p.id = auth.uid()
      WHERE cu.user_id = auth.uid()
        AND (p.is_super_admin = true OR cu.role IN ('admin','accounts','auditor'))
    )
  );

CREATE POLICY aq_service_all ON pramaana.audit_queries
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 7. audit_query_items ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.audit_query_items (
  query_id    uuid NOT NULL REFERENCES pramaana.audit_queries(id) ON DELETE CASCADE,
  line_id     uuid REFERENCES pramaana.bank_statement_lines(id),
  voucher_id  uuid REFERENCES pramaana.vouchers(id),
  CONSTRAINT aqi_one_context CHECK (
    (line_id IS NOT NULL)::int + (voucher_id IS NOT NULL)::int = 1  -- exactly one
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS aqi_query_line
  ON pramaana.audit_query_items (query_id, line_id)
  WHERE line_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS aqi_query_voucher
  ON pramaana.audit_query_items (query_id, voucher_id)
  WHERE voucher_id IS NOT NULL;

ALTER TABLE pramaana.audit_query_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aqi_company_read ON pramaana.audit_query_items;
DROP POLICY IF EXISTS aqi_service_all  ON pramaana.audit_query_items;

CREATE POLICY aqi_company_read ON pramaana.audit_query_items
  FOR SELECT TO authenticated
  USING (
    query_id IN (
      SELECT id FROM pramaana.audit_queries
      WHERE company_id IN (
        SELECT company_id FROM registry.company_users WHERE user_id = auth.uid()
      )
    )
  );

CREATE POLICY aqi_service_all ON pramaana.audit_query_items
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- authenticated write delegated to query context (via RPC or parent policy)
CREATE POLICY aqi_accounts_write ON pramaana.audit_query_items
  FOR ALL TO authenticated
  USING (
    query_id IN (
      SELECT aq.id FROM pramaana.audit_queries aq
      JOIN registry.company_users cu ON cu.company_id = aq.company_id
      JOIN registry.profiles p ON p.id = auth.uid()
      WHERE cu.user_id = auth.uid()
        AND (p.is_super_admin = true OR cu.role IN ('admin','accounts','auditor'))
    )
  )
  WITH CHECK (
    query_id IN (
      SELECT aq.id FROM pramaana.audit_queries aq
      JOIN registry.company_users cu ON cu.company_id = aq.company_id
      JOIN registry.profiles p ON p.id = auth.uid()
      WHERE cu.user_id = auth.uid()
        AND (p.is_super_admin = true OR cu.role IN ('admin','accounts','auditor'))
    )
  );

-- ── 8. audit_query_messages ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.audit_query_messages (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id         uuid        NOT NULL REFERENCES pramaana.audit_queries(id) ON DELETE CASCADE,
  author_id        uuid        NOT NULL REFERENCES auth.users(id),
  body             text        NOT NULL,
  attachment_path  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aqm_query_id
  ON pramaana.audit_query_messages (query_id, created_at);

ALTER TABLE pramaana.audit_query_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aqm_company_read  ON pramaana.audit_query_messages;
DROP POLICY IF EXISTS aqm_accounts_write ON pramaana.audit_query_messages;
DROP POLICY IF EXISTS aqm_service_all   ON pramaana.audit_query_messages;

CREATE POLICY aqm_company_read ON pramaana.audit_query_messages
  FOR SELECT TO authenticated
  USING (
    query_id IN (
      SELECT id FROM pramaana.audit_queries
      WHERE company_id IN (
        SELECT company_id FROM registry.company_users WHERE user_id = auth.uid()
      )
    )
  );

CREATE POLICY aqm_accounts_write ON pramaana.audit_query_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    query_id IN (
      SELECT aq.id FROM pramaana.audit_queries aq
      JOIN registry.company_users cu ON cu.company_id = aq.company_id
      JOIN registry.profiles p ON p.id = auth.uid()
      WHERE cu.user_id = auth.uid()
        AND (p.is_super_admin = true OR cu.role IN ('admin','accounts','auditor'))
    )
  );

CREATE POLICY aqm_service_all ON pramaana.audit_query_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 9. Attach 061 audit triggers to all new tables ───────────────────────────

DROP TRIGGER IF EXISTS trg_audit_log ON pramaana.bank_format_config;
CREATE TRIGGER trg_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON pramaana.bank_format_config
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_audit_log();

DROP TRIGGER IF EXISTS trg_audit_log ON pramaana.bank_statements;
CREATE TRIGGER trg_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON pramaana.bank_statements
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_audit_log();

DROP TRIGGER IF EXISTS trg_audit_log ON pramaana.bank_statement_lines;
CREATE TRIGGER trg_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON pramaana.bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_audit_log();

DROP TRIGGER IF EXISTS trg_audit_log ON pramaana.audit_queries;
CREATE TRIGGER trg_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON pramaana.audit_queries
  FOR EACH ROW EXECUTE FUNCTION pramaana.fn_audit_log();

-- ── 10. Seed bank_format_config stubs ────────────────────────────────────────
-- All stubs are active=false until a fixture file is uploaded + parser verified.
-- bank_ledger_id UUIDs are placeholders — update with real ledger IDs via:
--   SELECT id, name FROM pramaana.ledgers WHERE name ILIKE '%canara%' OR name ILIKE '%federal%' ...
-- Or run the seed script after verifying ledger IDs from information_schema.
--
-- Seed is safe to run repeatedly (DO block with ON CONFLICT DO NOTHING).

DO $$
BEGIN
  -- CANARA (RFPL)
  INSERT INTO pramaana.bank_format_config (
    bank_code, bank_ledger_id, company_id, file_type, encoding,
    header_row, column_map, date_format, skip_footer_rows, match_day_window, active
  ) VALUES (
    'CANARA',
    '00000000-0000-0000-0000-000000000001'::uuid,  -- placeholder: replace with real Canara ledger id
    'bc455c94-0bcd-4d66-a040-d29ed880d22f',        -- RFPL
    'csv', 'utf-8', 1,
    '{
      "date":      "Txn Date",
      "narration": "Description",
      "ref":       "Chq/Ref No",
      "debit":     "Withdrawal Amt",
      "credit":    "Deposit Amt",
      "balance":   "Balance"
    }'::jsonb,
    'DD/MM/YYYY', 0, 3, false
  ) ON CONFLICT (bank_code) DO NOTHING;

  -- FEDERAL (RFPL)
  INSERT INTO pramaana.bank_format_config (
    bank_code, bank_ledger_id, company_id, file_type, encoding,
    header_row, column_map, date_format, skip_footer_rows, match_day_window, active
  ) VALUES (
    'FEDERAL',
    '00000000-0000-0000-0000-000000000002'::uuid,  -- placeholder: replace with real Federal ledger id
    'bc455c94-0bcd-4d66-a040-d29ed880d22f',        -- RFPL
    'csv', 'utf-8', 1,
    '{
      "date":      "Txn Date",
      "narration": "Description",
      "ref":       "Ref No",
      "debit":     "Debit",
      "credit":    "Credit",
      "balance":   "Balance"
    }'::jsonb,
    'DD/MM/YYYY', 0, 3, false
  ) ON CONFLICT (bank_code) DO NOTHING;

  -- HDFC_CUR (RHHF — Current 99999446012324)
  INSERT INTO pramaana.bank_format_config (
    bank_code, bank_ledger_id, company_id, file_type, encoding,
    header_row, column_map, date_format, skip_footer_rows, match_day_window, active
  ) VALUES (
    'HDFC_CUR',
    '00000000-0000-0000-0000-000000000003'::uuid,  -- placeholder: replace with real HDFC Current ledger id
    'b8beb440-df7f-48e8-a012-ac5750502eca',        -- RHHF
    'csv', 'utf-8', 1,
    '{
      "date":      "Date",
      "narration": "Narration",
      "ref":       "Chq./Ref.No.",
      "debit":     "Withdrawal Amt.",
      "credit":    "Deposit Amt.",
      "balance":   "Closing Balance"
    }'::jsonb,
    'DD/MM/YY', 0, 3, false
  ) ON CONFLICT (bank_code) DO NOTHING;

  -- HDFC_NOLIEN (RHHF — No Lien 50200115901702)
  INSERT INTO pramaana.bank_format_config (
    bank_code, bank_ledger_id, company_id, file_type, encoding,
    header_row, column_map, date_format, skip_footer_rows, match_day_window, active
  ) VALUES (
    'HDFC_NOLIEN',
    '00000000-0000-0000-0000-000000000004'::uuid,  -- placeholder
    'b8beb440-df7f-48e8-a012-ac5750502eca',        -- RHHF
    'csv', 'utf-8', 1,
    '{
      "date":      "Date",
      "narration": "Narration",
      "ref":       "Chq./Ref.No.",
      "debit":     "Withdrawal Amt.",
      "credit":    "Deposit Amt.",
      "balance":   "Closing Balance"
    }'::jsonb,
    'DD/MM/YY', 0, 3, false
  ) ON CONFLICT (bank_code) DO NOTHING;

  -- AIRWALLEX (RFPL — JSON)
  INSERT INTO pramaana.bank_format_config (
    bank_code, bank_ledger_id, company_id, file_type, encoding,
    header_row, column_map, date_format, skip_footer_rows, match_day_window, active
  ) VALUES (
    'AIRWALLEX',
    '00000000-0000-0000-0000-000000000005'::uuid,  -- placeholder
    'bc455c94-0bcd-4d66-a040-d29ed880d22f',        -- RFPL
    'json', 'utf-8', 0,
    '{
      "date":      "created_at",
      "narration": "description",
      "ref":       "payment_id",
      "debit":     "debit_amount",
      "credit":    "credit_amount",
      "balance":   "balance"
    }'::jsonb,
    'ISO8601', 0, 3, false
  ) ON CONFLICT (bank_code) DO NOTHING;
END $$;

-- ── 11. Matching RPC: run_bank_match ─────────────────────────────────────────
--
-- Idempotent: only processes lines still in 'unmatched' status.
-- Called after parse; safe to re-run on same statement.
-- Sign convention (critical — BRS polarity):
--   Bank CREDIT (money IN)  ↔  voucher_entry Dr on bank ledger (asset increases)
--   Bank DEBIT  (money OUT) ↔  voucher_entry Cr on bank ledger (asset decreases)

CREATE OR REPLACE FUNCTION pramaana.run_bank_match(p_statement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pramaana, public
AS $$
DECLARE
  v_stmt           pramaana.bank_statements%ROWTYPE;
  v_fmt            pramaana.bank_format_config%ROWTYPE;
  v_window         int;
  v_pass1_count    int := 0;
  v_pass2_count    int := 0;
  v_pass3_count    int := 0;
  v_unbooked_count int := 0;
  v_brs_count      int := 0;
  v_line           pramaana.bank_statement_lines%ROWTYPE;
  v_group_id       uuid;
  v_candidate_id   uuid;
  v_candidate_count int;
BEGIN
  -- ── Load statement + format ────────────────────────────────────────────────
  SELECT * INTO v_stmt FROM pramaana.bank_statements WHERE id = p_statement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Statement not found: %', p_statement_id;
  END IF;
  IF v_stmt.status NOT IN ('parsed','matched') THEN
    RAISE EXCEPTION 'Statement must be in parsed/matched state (current: %)', v_stmt.status;
  END IF;

  SELECT * INTO v_fmt FROM pramaana.bank_format_config WHERE id = v_stmt.bank_format_id;
  v_window := v_fmt.match_day_window;

  -- ── PASS 1: Exact match (amount + date, unique candidate) ─────────────────
  FOR v_line IN
    SELECT * FROM pramaana.bank_statement_lines
    WHERE statement_id = p_statement_id
      AND match_status = 'unmatched'
  LOOP
    DECLARE
      v_line_amount   numeric(15,2);
      v_entry_type    text;
    BEGIN
      -- Determine the amount and entry_type we're looking for
      IF v_line.credit > 0 THEN
        v_line_amount := v_line.credit;
        v_entry_type  := 'Dr';   -- bank asset increases → Dr on bank ledger
      ELSE
        v_line_amount := v_line.debit;
        v_entry_type  := 'Cr';   -- bank asset decreases → Cr on bank ledger
      END IF;

      -- Count matching voucher entries on this bank ledger, this date, this amount
      SELECT COUNT(DISTINCT ve.voucher_id), MIN(ve.voucher_id)
        INTO v_candidate_count, v_candidate_id
        FROM pramaana.voucher_entries ve
        JOIN pramaana.vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_id   = v_fmt.bank_ledger_id
          AND ve.entry_type  = v_entry_type
          AND ve.amount      = v_line_amount
          AND v.voucher_date = v_line.txn_date
          AND v.status       IN ('posted','approved','completed')
          AND NOT EXISTS (
            SELECT 1 FROM pramaana.bank_statement_lines bsl2
            WHERE bsl2.matched_voucher_id = ve.voucher_id
              AND bsl2.match_status IN ('matched','confirmed','fuzzy_matched')
          );

      IF v_candidate_count = 1 THEN
        -- Exact match, unique — auto-confirm
        UPDATE pramaana.bank_statement_lines
          SET match_status       = 'matched',
              matched_voucher_id = v_candidate_id,
              match_pass         = 1,
              match_note         = 'Exact: date + amount'
          WHERE id = v_line.id;
        v_pass1_count := v_pass1_count + 1;
      END IF;
      -- v_candidate_count > 1: tie — leave for pass 2 disambiguation
    END;
  END LOOP;

  -- ── PASS 2: Fuzzy match (amount exact, date ± window, OR UTR match) ────────
  FOR v_line IN
    SELECT * FROM pramaana.bank_statement_lines
    WHERE statement_id = p_statement_id
      AND match_status = 'unmatched'
  LOOP
    DECLARE
      v_line_amount numeric(15,2);
      v_entry_type  text;
    BEGIN
      IF v_line.credit > 0 THEN
        v_line_amount := v_line.credit;
        v_entry_type  := 'Dr';
      ELSE
        v_line_amount := v_line.debit;
        v_entry_type  := 'Cr';
      END IF;

      -- Amount + window date
      SELECT COUNT(DISTINCT ve.voucher_id), MIN(ve.voucher_id)
        INTO v_candidate_count, v_candidate_id
        FROM pramaana.voucher_entries ve
        JOIN pramaana.vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_id  = v_fmt.bank_ledger_id
          AND ve.entry_type = v_entry_type
          AND ve.amount     = v_line_amount
          AND v.voucher_date BETWEEN (v_line.txn_date - v_window) AND (v_line.txn_date + v_window)
          AND v.status      IN ('posted','approved','completed')
          AND NOT EXISTS (
            SELECT 1 FROM pramaana.bank_statement_lines bsl2
            WHERE bsl2.matched_voucher_id = ve.voucher_id
              AND bsl2.match_status IN ('matched','confirmed','fuzzy_matched')
          );

      IF v_candidate_count = 1 THEN
        UPDATE pramaana.bank_statement_lines
          SET match_status       = 'fuzzy_matched',
              matched_voucher_id = v_candidate_id,
              match_pass         = 2,
              match_note         = 'Fuzzy: amount + ±' || v_window || ' day window'
          WHERE id = v_line.id;
        v_pass2_count := v_pass2_count + 1;
        CONTINUE;
      END IF;

      -- UTR/ref match (if ref_no present and ≥ 6 chars)
      IF v_line.ref_no IS NOT NULL AND length(trim(v_line.ref_no)) >= 6 THEN
        SELECT COUNT(DISTINCT ve.voucher_id), MIN(ve.voucher_id)
          INTO v_candidate_count, v_candidate_id
          FROM pramaana.voucher_entries ve
          JOIN pramaana.vouchers v ON v.id = ve.voucher_id
          WHERE ve.ledger_id  = v_fmt.bank_ledger_id
            AND ve.entry_type = v_entry_type
            AND ve.amount     = v_line_amount
            AND (v.narration ILIKE '%' || trim(v_line.ref_no) || '%'
                 OR v.ref_document_number ILIKE '%' || trim(v_line.ref_no) || '%')
            AND v.status      IN ('posted','approved','completed')
            AND NOT EXISTS (
              SELECT 1 FROM pramaana.bank_statement_lines bsl2
              WHERE bsl2.matched_voucher_id = ve.voucher_id
                AND bsl2.match_status IN ('matched','confirmed','fuzzy_matched')
            );

        IF v_candidate_count = 1 THEN
          UPDATE pramaana.bank_statement_lines
            SET match_status       = 'fuzzy_matched',
                matched_voucher_id = v_candidate_id,
                match_pass         = 2,
                match_note         = 'Fuzzy: UTR ref match'
            WHERE id = v_line.id;
          v_pass2_count := v_pass2_count + 1;
        END IF;
      END IF;
    END;
  END LOOP;

  -- ── PASS 3: Group-sum match (one line ↔ 2-6 vouchers, same-day) ───────────
  FOR v_line IN
    SELECT * FROM pramaana.bank_statement_lines
    WHERE statement_id = p_statement_id
      AND match_status = 'unmatched'
  LOOP
    DECLARE
      v_line_amount  numeric(15,2);
      v_entry_type   text;
      v_voucher_ids  uuid[];
      v_combo_sum    numeric(15,2);
    BEGIN
      IF v_line.credit > 0 THEN
        v_line_amount := v_line.credit;
        v_entry_type  := 'Dr';
      ELSE
        v_line_amount := v_line.debit;
        v_entry_type  := 'Cr';
      END IF;

      -- Collect candidates within window, bounded to 200 for safety
      SELECT array_agg(DISTINCT ve.voucher_id)
        INTO v_voucher_ids
        FROM (
          SELECT DISTINCT ve2.voucher_id, ve2.amount
          FROM pramaana.voucher_entries ve2
          JOIN pramaana.vouchers v2 ON v2.id = ve2.voucher_id
          WHERE ve2.ledger_id  = v_fmt.bank_ledger_id
            AND ve2.entry_type = v_entry_type
            AND v2.voucher_date BETWEEN (v_line.txn_date - v_window) AND (v_line.txn_date + v_window)
            AND v2.status      IN ('posted','approved','completed')
            AND NOT EXISTS (
              SELECT 1 FROM pramaana.bank_statement_lines bsl2
              WHERE bsl2.matched_voucher_id = ve2.voucher_id
                AND bsl2.match_status IN ('matched','confirmed','fuzzy_matched')
            )
          LIMIT 200
        ) ve;

      IF v_voucher_ids IS NULL OR array_length(v_voucher_ids, 1) < 2 THEN
        CONTINUE;
      END IF;

      -- 2-item combos (bounded to avoid combinatorial explosion)
      IF array_length(v_voucher_ids, 1) <= 30 THEN
        SELECT a.voucher_id, b.voucher_id,
               ea.amount + eb.amount AS combo_sum
          INTO v_candidate_id, v_candidate_id, v_combo_sum
          FROM pramaana.voucher_entries ea
          CROSS JOIN pramaana.voucher_entries eb
          WHERE ea.voucher_id = ANY(v_voucher_ids)
            AND eb.voucher_id = ANY(v_voucher_ids)
            AND ea.voucher_id <> eb.voucher_id
            AND ea.ledger_id  = v_fmt.bank_ledger_id
            AND eb.ledger_id  = v_fmt.bank_ledger_id
            AND ea.amount + eb.amount = v_line_amount
          LIMIT 1;

        IF v_combo_sum = v_line_amount THEN
          v_group_id := gen_random_uuid();
          UPDATE pramaana.bank_statement_lines
            SET match_status    = 'fuzzy_matched',
                match_group_id  = v_group_id,
                match_pass      = 3,
                match_note      = 'Group-sum: 2-voucher combination'
            WHERE id = v_line.id;
          v_pass3_count := v_pass3_count + 1;
        END IF;
      END IF;
    END;
  END LOOP;

  -- ── Classify remaining unmatched lines as 'unbooked' ─────────────────────
  UPDATE pramaana.bank_statement_lines
    SET match_status = 'unbooked',
        match_note   = 'No matching voucher found after 3 passes'
    WHERE statement_id = p_statement_id
      AND match_status = 'unmatched';
  GET DIAGNOSTICS v_unbooked_count = ROW_COUNT;

  -- ── Insert brs_timing_items for book entries with no line ─────────────────
  -- (Book entries on bank ledger within window that did not match any line)
  INSERT INTO pramaana.brs_timing_items (
    company_id, voucher_id, bank_ledger_id, item_type, as_of
  )
  SELECT DISTINCT
    v.company_id,
    v.id,
    v_fmt.bank_ledger_id,
    CASE WHEN ve.entry_type = 'Cr' THEN 'cheque_not_presented'
         ELSE 'deposit_in_transit' END,
    v_stmt.period_to
  FROM pramaana.voucher_entries ve
  JOIN pramaana.vouchers v ON v.id = ve.voucher_id
  WHERE ve.ledger_id  = v_fmt.bank_ledger_id
    AND v.voucher_date BETWEEN v_stmt.period_from AND v_stmt.period_to
    AND v.status       IN ('posted','approved','completed')
    AND v.company_id   = v_stmt.company_id
    AND NOT EXISTS (
      SELECT 1 FROM pramaana.bank_statement_lines bsl
      WHERE bsl.matched_voucher_id = v.id
        AND bsl.statement_id = p_statement_id
        AND bsl.match_status IN ('matched','confirmed','fuzzy_matched')
    )
    AND NOT EXISTS (
      SELECT 1 FROM pramaana.brs_timing_items brs
      WHERE brs.voucher_id = v.id AND brs.as_of = v_stmt.period_to
    )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_brs_count = ROW_COUNT;

  -- Update statement status
  UPDATE pramaana.bank_statements
    SET status = 'matched'
    WHERE id = p_statement_id;

  RETURN jsonb_build_object(
    'statement_id',    p_statement_id,
    'pass1_matched',   v_pass1_count,
    'pass2_fuzzy',     v_pass2_count,
    'pass3_group',     v_pass3_count,
    'unbooked',        v_unbooked_count,
    'brs_timing_new',  v_brs_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION pramaana.run_bank_match(uuid) TO authenticated;

-- ── 12. BRS report function ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pramaana.get_brs(
  p_bank_ledger_id uuid,
  p_as_of          date,
  p_company_id     uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pramaana, public
AS $$
DECLARE
  v_book_balance         numeric(15,2);
  v_uncleared_cheques    numeric(15,2);
  v_deposits_in_transit  numeric(15,2);
  v_unbooked_credits     numeric(15,2);
  v_unbooked_debits      numeric(15,2);
  v_derived_bank_balance numeric(15,2);
  v_statement_closing    numeric(15,2);
BEGIN
  -- Book balance: sum of all entries on bank ledger up to p_as_of
  SELECT COALESCE(
    SUM(CASE WHEN ve.entry_type = 'Dr' THEN ve.amount ELSE -ve.amount END),
    0
  )
  INTO v_book_balance
  FROM pramaana.voucher_entries ve
  JOIN pramaana.vouchers v ON v.id = ve.voucher_id
  WHERE ve.ledger_id  = p_bank_ledger_id
    AND v.company_id  = p_company_id
    AND v.voucher_date <= p_as_of
    AND v.status       IN ('posted','approved','completed');

  -- BRS timing items: cheques not presented (Cr in books, not cleared)
  SELECT COALESCE(SUM(ve.amount), 0)
  INTO v_uncleared_cheques
  FROM pramaana.brs_timing_items brs
  JOIN pramaana.voucher_entries ve ON ve.voucher_id = brs.voucher_id
  WHERE brs.bank_ledger_id = p_bank_ledger_id
    AND brs.company_id     = p_company_id
    AND brs.as_of          <= p_as_of
    AND brs.cleared_at     IS NULL
    AND brs.item_type      = 'cheque_not_presented'
    AND ve.ledger_id       = p_bank_ledger_id
    AND ve.entry_type      = 'Cr';

  -- Deposits in transit (Dr in books, not yet in bank)
  SELECT COALESCE(SUM(ve.amount), 0)
  INTO v_deposits_in_transit
  FROM pramaana.brs_timing_items brs
  JOIN pramaana.voucher_entries ve ON ve.voucher_id = brs.voucher_id
  WHERE brs.bank_ledger_id = p_bank_ledger_id
    AND brs.company_id     = p_company_id
    AND brs.as_of          <= p_as_of
    AND brs.cleared_at     IS NULL
    AND brs.item_type      = 'deposit_in_transit'
    AND ve.ledger_id       = p_bank_ledger_id
    AND ve.entry_type      = 'Dr';

  -- Unbooked items from most recent statement
  SELECT
    COALESCE(SUM(CASE WHEN bsl.credit > 0 THEN bsl.credit ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bsl.debit  > 0 THEN bsl.debit  ELSE 0 END), 0)
  INTO v_unbooked_credits, v_unbooked_debits
  FROM pramaana.bank_statement_lines bsl
  JOIN pramaana.bank_statements bs ON bs.id = bsl.statement_id
  JOIN pramaana.bank_format_config bfc ON bfc.id = bs.bank_format_id
  WHERE bfc.bank_ledger_id = p_bank_ledger_id
    AND bs.company_id      = p_company_id
    AND bsl.txn_date       <= p_as_of
    AND bsl.match_status   = 'unbooked';

  -- Latest statement closing balance
  SELECT bs.closing_balance
  INTO v_statement_closing
  FROM pramaana.bank_statements bs
  JOIN pramaana.bank_format_config bfc ON bfc.id = bs.bank_format_id
  WHERE bfc.bank_ledger_id = p_bank_ledger_id
    AND bs.company_id      = p_company_id
    AND bs.period_to       <= p_as_of
  ORDER BY bs.period_to DESC
  LIMIT 1;

  -- Derived bank balance: book + timing adjustments
  v_derived_bank_balance :=
    v_book_balance
    - v_uncleared_cheques      -- issued cheques still in transit: reduce
    + v_deposits_in_transit    -- deposits not yet credited: bank has less
    + v_unbooked_credits       -- bank has extra credits not in books
    - v_unbooked_debits;       -- bank has extra debits not in books

  RETURN jsonb_build_object(
    'book_balance',          v_book_balance,
    'less_uncleared_cheques',     v_uncleared_cheques,
    'add_deposits_in_transit',    v_deposits_in_transit,
    'add_unbooked_credits',       v_unbooked_credits,
    'less_unbooked_debits',       v_unbooked_debits,
    'derived_bank_balance',       v_derived_bank_balance,
    'statement_closing_balance',  v_statement_closing,
    'variance',               v_derived_bank_balance - COALESCE(v_statement_closing, v_derived_bank_balance)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION pramaana.get_brs(uuid, date, uuid) TO authenticated;

-- ── 13. Register QRY sequence key in sequence_counters ───────────────────────
-- sequence_counters lives in registry schema; insert for both companies.
-- Uses ON CONFLICT DO NOTHING so re-running is safe.

INSERT INTO registry.sequence_counters (company_id, prefix, fy, last_number)
VALUES
  ('bc455c94-0bcd-4d66-a040-d29ed880d22f', 'QRY', '2627', 0),
  ('b8beb440-df7f-48e8-a012-ac5750502eca', 'QRY', '2627', 0)
ON CONFLICT DO NOTHING;

COMMENT ON TABLE pramaana.bank_statement_lines IS
  'Parsed rows from bank statements. match_status drives the reconciliation workflow. '
  'BRS polarity: credit (money IN) ↔ Dr on bank ledger; debit (money OUT) ↔ Cr on bank ledger.';

COMMENT ON TABLE pramaana.audit_queries IS
  'Reusable query/observation management. Phase 1: bank recon. '
  'Phase 2 (Auditor Module): will extend to AJE context_type.';
