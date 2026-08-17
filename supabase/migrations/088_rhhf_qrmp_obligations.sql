-- ════════════════════════════════════════════════════════════════════════════
-- 088_rhhf_qrmp_obligations.sql
--
-- Seeds RHHF's missing QRMP GST obligations for FY26-27.
-- RHHF is GST-registered under QRMP (Kerala, category B → 22nd).
-- Nil quarterly returns must be filed even during construction phase;
-- non-filing accrues ₹20/day late fee and jeopardises accumulated ITC.
--
-- QRMP due dates:
--   GSTR-1 (quarterly, IFF optional): 13th of month after quarter end
--   GSTR-3B (quarterly):              22nd of month after quarter end (Kerala = Cat B)
--   PMT-06 (monthly payment, months 1&2 of quarter): 25th of each month
--
-- FY26-27 quarters remaining as of Aug-2026:
--   Q1: Apr-Jun 2026 → OVERDUE (GSTR-1 due Jul-13, GSTR-3B due Jul-22)
--   Q2: Jul-Sep 2026 → due Oct-13 / Oct-22
--   Q3: Oct-Dec 2026 → due Jan-13 / Jan-22
--   Q4: Jan-Mar 2027 → due Apr-13 / Apr-22
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  RHHF CONSTANT UUID := 'b8beb440-df7f-48e8-a012-ac5750502eca';
BEGIN

  -- ── Q1 FY26-27 (Apr-Jun 2026) — overdue ────────────────────────────────────
  INSERT INTO pramaana.compliance_obligations
    (company_id, obligation, period, period_from, period_to, due_date, status)
  VALUES
    (RHHF, 'GSTR-1',  'Q1 FY26-27', '2026-04-01', '2026-06-30', '2026-07-13', 'overdue'),
    (RHHF, 'GSTR-3B', 'Q1 FY26-27', '2026-04-01', '2026-06-30', '2026-07-22', 'overdue')
  ON CONFLICT DO NOTHING;

  -- ── Q2 FY26-27 (Jul-Sep 2026) ──────────────────────────────────────────────
  INSERT INTO pramaana.compliance_obligations
    (company_id, obligation, period, period_from, period_to, due_date, status)
  VALUES
    (RHHF, 'GSTR-1',  'Q2 FY26-27', '2026-07-01', '2026-09-30', '2026-10-13', 'upcoming'),
    (RHHF, 'GSTR-3B', 'Q2 FY26-27', '2026-07-01', '2026-09-30', '2026-10-22', 'upcoming')
  ON CONFLICT DO NOTHING;

  -- ── Q3 FY26-27 (Oct-Dec 2026) ──────────────────────────────────────────────
  INSERT INTO pramaana.compliance_obligations
    (company_id, obligation, period, period_from, period_to, due_date, status)
  VALUES
    (RHHF, 'GSTR-1',  'Q3 FY26-27', '2026-10-01', '2026-12-31', '2027-01-13', 'upcoming'),
    (RHHF, 'GSTR-3B', 'Q3 FY26-27', '2026-10-01', '2026-12-31', '2027-01-22', 'upcoming')
  ON CONFLICT DO NOTHING;

  -- ── Q4 FY26-27 (Jan-Mar 2027) ──────────────────────────────────────────────
  INSERT INTO pramaana.compliance_obligations
    (company_id, obligation, period, period_from, period_to, due_date, status)
  VALUES
    (RHHF, 'GSTR-1',  'Q4 FY26-27', '2027-01-01', '2027-03-31', '2027-04-13', 'upcoming'),
    (RHHF, 'GSTR-3B', 'Q4 FY26-27', '2027-01-01', '2027-03-31', '2027-04-22', 'upcoming')
  ON CONFLICT DO NOTHING;

  -- ── PMT-06 monthly payments (months 1 & 2 of each remaining quarter) ────────
  -- Q2: Aug-25 and Sep-25
  INSERT INTO pramaana.compliance_obligations
    (company_id, obligation, period, period_from, period_to, due_date, status)
  VALUES
    (RHHF, 'QRMP-PMT-06', 'Aug-2026', '2026-08-01', '2026-08-31', '2026-08-25', 'upcoming'),
    (RHHF, 'QRMP-PMT-06', 'Sep-2026', '2026-09-01', '2026-09-30', '2026-09-25', 'upcoming'),
    (RHHF, 'QRMP-PMT-06', 'Oct-2026', '2026-10-01', '2026-10-31', '2026-10-25', 'upcoming'),
    (RHHF, 'QRMP-PMT-06', 'Nov-2026', '2026-11-01', '2026-11-30', '2026-11-25', 'upcoming'),
    (RHHF, 'QRMP-PMT-06', 'Jan-2027', '2027-01-01', '2027-01-31', '2027-01-25', 'upcoming'),
    (RHHF, 'QRMP-PMT-06', 'Feb-2027', '2027-02-01', '2027-02-28', '2027-02-25', 'upcoming')
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'RHHF QRMP obligations seeded for FY26-27.';
END $$;
