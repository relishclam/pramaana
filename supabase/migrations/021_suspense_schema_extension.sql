-- ── 021_suspense_schema_extension.sql ────────────────────────────────────────
-- Extends the pramaana schema with suspense advance workflow fields.
-- Run once in Supabase SQL Editor → Database → SQL Editor.

-- ── 1. Add suspense columns to pramaana.vouchers ─────────────────────────────

ALTER TABLE pramaana.vouchers
  ADD COLUMN IF NOT EXISTS is_suspense      BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS suspense_purpose TEXT,
  ADD COLUMN IF NOT EXISTS suspense_balance NUMERIC(15,2) DEFAULT 0;

-- ── 2. Add token + advance link to pramaana.settlement_sessions ───────────────
--    token       → the UUID embedded in the staff SMS link (/settle/{token})
--    expires_at  → NULL means permanent; set to future timestamp to expire
--    advance_voucher_id → which suspense advance this session belongs to

ALTER TABLE pramaana.settlement_sessions
  ADD COLUMN IF NOT EXISTS token              UUID        NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS expires_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS advance_voucher_id UUID        REFERENCES pramaana.vouchers(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_sessions_token
  ON pramaana.settlement_sessions(token);

-- ── 3. Add expense detail fields to pramaana.suspense_settlements ─────────────
--    entry_type        → 'expense' | 'refund' | 'topup'
--    description       → what the money was spent on
--    head_of_account   → expense category (free text — ledger name or category)
--    reference_number  → bill / receipt number
--    invoice_available → staff confirmed they have a bill

ALTER TABLE pramaana.suspense_settlements
  ADD COLUMN IF NOT EXISTS entry_type        TEXT    NOT NULL DEFAULT 'expense',
  ADD COLUMN IF NOT EXISTS description       TEXT,
  ADD COLUMN IF NOT EXISTS head_of_account   TEXT,
  ADD COLUMN IF NOT EXISTS reference_number  TEXT,
  ADD COLUMN IF NOT EXISTS invoice_available BOOLEAN;

-- ── 4. Anon access for the public /settle/:token page ────────────────────────
--    The settlement URL is /settle/{uuid-token}. Possession of the UUID token
--    is the access credential — a 128-bit random UUID provides sufficient
--    entropy (2^122 combinations) to make guessing infeasible.

GRANT USAGE  ON SCHEMA pramaana                   TO anon;
GRANT SELECT ON pramaana.settlement_sessions       TO anon;
GRANT SELECT ON pramaana.vouchers                  TO anon;
GRANT SELECT, INSERT ON pramaana.suspense_settlements TO anon;

-- Allow anon to read settlement_sessions (token URL is the auth)
DROP POLICY IF EXISTS "anon_read_settlement_sessions" ON pramaana.settlement_sessions;
CREATE POLICY "anon_read_settlement_sessions"
  ON pramaana.settlement_sessions
  FOR SELECT TO anon
  USING (true);

-- Allow anon to read suspense vouchers (for showing advance details on settle page)
DROP POLICY IF EXISTS "anon_read_suspense_vouchers" ON pramaana.vouchers;
CREATE POLICY "anon_read_suspense_vouchers"
  ON pramaana.vouchers
  FOR SELECT TO anon
  USING (is_suspense = true);

-- Allow anon to read suspense_settlements (staff can see their own submitted entries)
DROP POLICY IF EXISTS "anon_read_suspense_settlements" ON pramaana.suspense_settlements;
CREATE POLICY "anon_read_suspense_settlements"
  ON pramaana.suspense_settlements
  FOR SELECT TO anon
  USING (true);

-- Allow anon to INSERT suspense_settlements — only if there is an active
-- (non-completed, non-expired) session for the advance_voucher_id being submitted against.
-- This prevents random inserts against arbitrary voucher IDs.
DROP POLICY IF EXISTS "anon_insert_suspense_settlements" ON pramaana.suspense_settlements;
CREATE POLICY "anon_insert_suspense_settlements"
  ON pramaana.suspense_settlements
  FOR INSERT TO anon
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM pramaana.settlement_sessions ss
      WHERE ss.advance_voucher_id = suspense_settlements.advance_voucher_id
        AND ss.status            != 'completed'
        AND (ss.expires_at IS NULL OR ss.expires_at > NOW())
    )
  );

-- ── Verification ──────────────────────────────────────────────────────────────
-- After running, confirm with:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'pramaana' AND table_name = 'vouchers'
--   AND column_name IN ('is_suspense','suspense_purpose','suspense_balance');
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'pramaana' AND table_name = 'settlement_sessions'
--   AND column_name IN ('token','expires_at','advance_voucher_id');
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'pramaana' AND table_name = 'suspense_settlements'
--   AND column_name IN ('entry_type','description','head_of_account','reference_number','invoice_available');
