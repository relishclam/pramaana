-- ════════════════════════════════════════════════════════════════
-- RELISH PLATFORM — Pramaana Status Enum Fixes + Payment Columns
-- Migration: 025_fix_status_enums_and_payment_columns.sql
-- Target:    Supabase project mmkbknnzgpvsqgnynrbe
-- Resolves:  Assessment C-01 — three status CHECK constraint mismatches
--            between migration 008 definitions and actual application code
--
-- Background:
--   Migration 008 defined status CHECK constraints that do not match
--   the values written by suspense.ts. The suspense workflow is either
--   working because these constraints were amended directly in the live
--   database without a tracked migration, or is silently failing.
--   This migration aligns the constraints with what the code actually writes.
--
-- All ALTER TABLE statements use DROP CONSTRAINT IF EXISTS before
-- re-adding — safe to run on both the old and new schema.
-- ════════════════════════════════════════════════════════════════

-- ── Verify before running ─────────────────────────────────────────────────────
-- Run this first to see what constraints currently exist in the live DB:
--
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid IN (
--   'pramaana.vouchers'::regclass,
--   'pramaana.suspense_settlements'::regclass,
--   'pramaana.settlement_sessions'::regclass
-- ) AND contype = 'c'
-- ORDER BY conrelid::text, conname;
-- ─────────────────────────────────────────────────────────────────────────────


-- ════════════════════════════════════════════════════════════════
-- 1. pramaana.vouchers — status CHECK constraint
--
-- Migration 008 had: ('draft','pending_approval','approved','posted','cancelled')
-- suspense.ts writes: 'open', 'rejected', 'partial', 'closed'
-- approvals.ts writes: 'approved' → 'posted' (direct — 'approved' is ghost state)
-- New constraint includes all values written by application code.
-- ════════════════════════════════════════════════════════════════
ALTER TABLE pramaana.vouchers
  DROP CONSTRAINT IF EXISTS vouchers_status_check;

ALTER TABLE pramaana.vouchers
  ADD CONSTRAINT vouchers_status_check
  CHECK (status IN (
    'draft',
    'pending_approval',
    'approved',
    'completed',
    'posted',
    'cancelled',
    'open',
    'rejected',
    'partial',
    'closed'
  ));


-- ════════════════════════════════════════════════════════════════
-- 2. pramaana.suspense_settlements — status CHECK constraint
--
-- Migration 008 had: ('open','partial','cleared')
-- suspense.ts writes: 'pending', 'approved', 'rejected'
-- Zero overlap with the original constraint.
-- New constraint includes original values + application code values.
-- ════════════════════════════════════════════════════════════════
ALTER TABLE pramaana.suspense_settlements
  DROP CONSTRAINT IF EXISTS suspense_settlements_status_check;

ALTER TABLE pramaana.suspense_settlements
  ADD CONSTRAINT suspense_settlements_status_check
  CHECK (status IN (
    'pending',
    'approved',
    'rejected',
    'open',
    'partial',
    'cleared'
  ));


-- ════════════════════════════════════════════════════════════════
-- 3. pramaana.settlement_sessions — status CHECK constraint
--
-- Migration 008 had: ('draft','in_progress','completed','cancelled')
-- suspense.ts createOrRefreshSession() inserts status='open'
-- New constraint adds 'open' to the existing values.
-- ════════════════════════════════════════════════════════════════
ALTER TABLE pramaana.settlement_sessions
  DROP CONSTRAINT IF EXISTS settlement_sessions_status_check;

ALTER TABLE pramaana.settlement_sessions
  ADD CONSTRAINT settlement_sessions_status_check
  CHECK (status IN (
    'draft',
    'open',
    'in_progress',
    'completed',
    'cancelled'
  ));


-- ════════════════════════════════════════════════════════════════
-- 4. Add payment tracking columns to pramaana.vouchers
--
-- These support the post-approval OTP flow:
--   approved       → admin approves, OTP sent to payee
--   completed      → OTP verified by payee at point of payment
--   posted         → accounts marks payment made (UTR recorded)
--
-- otp_verified_at / otp_verified_by: when and by whom OTP was verified
-- completed_at / completed_by: when voucher moved to 'completed' state
-- paid_at / paid_by: when physical payment was recorded
-- merchant_upi_ref: UPI transaction reference from the payment app
-- ════════════════════════════════════════════════════════════════
ALTER TABLE pramaana.vouchers
  ADD COLUMN IF NOT EXISTS otp_verified_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS otp_verified_by  UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS completed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_by     UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS paid_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_by          UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS merchant_upi_ref TEXT;


-- ════════════════════════════════════════════════════════════════
-- 5. Add failed_attempts to pramaana.otp_sessions
--
-- Tracks failed verification attempts per session.
-- verifyPaymentOtp() rejects after failed_attempts >= 3 and
-- sets status='expired' to prevent further attempts.
-- ════════════════════════════════════════════════════════════════
ALTER TABLE pramaana.otp_sessions
  ADD COLUMN IF NOT EXISTS failed_attempts INT NOT NULL DEFAULT 0;


-- ════════════════════════════════════════════════════════════════
-- VERIFY — run after applying to confirm all constraints are correct
-- ════════════════════════════════════════════════════════════════
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN (
  'pramaana.vouchers'::regclass,
  'pramaana.suspense_settlements'::regclass,
  'pramaana.settlement_sessions'::regclass
) AND contype = 'c'
ORDER BY conrelid::text, conname;
