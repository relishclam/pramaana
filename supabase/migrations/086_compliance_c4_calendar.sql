-- ════════════════════════════════════════════════════════════════════════════
-- 086_compliance_c4_calendar.sql — Compliance Calendar (Phase C4)
--
-- Creates compliance_obligations table and seeds FY26-27 deadlines
-- for both RFPL and RHHF per the Compliance Module Work Order.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pramaana.compliance_obligations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID        NOT NULL,
  obligation       TEXT        NOT NULL
                   CHECK (obligation IN (
                     'GSTR-1','GSTR-3B','GSTR-9','GSTR-9C',
                     'TDS-deposit','26Q','24Q',
                     'AOC-4','MGT-7','DIR-3-KYC','ADT-1','ITR','44AB','AGM',
                     'LUT','QRMP-PMT-06','IEC-renewal','MSME-return'
                   )),
  period           TEXT,                   -- 'Aug-2026', 'Q2 FY26-27', 'FY26-27'
  period_from      DATE,
  period_to        DATE,
  due_date         DATE        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'upcoming'
                   CHECK (status IN ('upcoming','in_progress','filed','overdue','na','waived')),
  filed_ref        TEXT,                   -- ARN, CIN, SRN, acknowledgment no
  filed_date       DATE,
  amount_payable   NUMERIC(15,2),          -- late fee / tax payable if applicable
  amount_paid      NUMERIC(15,2),
  challan_id       UUID        REFERENCES pramaana.statutory_challans(id) ON DELETE SET NULL,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_company_due
  ON pramaana.compliance_obligations (company_id, due_date, status);

CREATE INDEX IF NOT EXISTS idx_compliance_overdue
  ON pramaana.compliance_obligations (due_date, status)
  WHERE status IN ('upcoming','in_progress');

ALTER TABLE pramaana.compliance_obligations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS co_company_read ON pramaana.compliance_obligations;
CREATE POLICY co_company_read ON pramaana.compliance_obligations
  FOR SELECT TO authenticated
  USING (company_id IN (
    SELECT cu.company_id FROM registry.company_users cu WHERE cu.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS co_company_write ON pramaana.compliance_obligations;
CREATE POLICY co_company_write ON pramaana.compliance_obligations
  FOR ALL TO authenticated
  USING (company_id IN (
    SELECT cu.company_id FROM registry.company_users cu WHERE cu.user_id = auth.uid()
  ))
  WITH CHECK (company_id IN (
    SELECT cu.company_id FROM registry.company_users cu WHERE cu.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS co_service_all ON pramaana.compliance_obligations;
CREATE POLICY co_service_all ON pramaana.compliance_obligations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Seed FY26-27 obligations ──────────────────────────────────────────────────

DO $$
DECLARE
  RFPL CONSTANT UUID := 'bc455c94-0bcd-4d66-a040-d29ed880d22f';
  RHHF CONSTANT UUID := 'b8beb440-df7f-48e8-a012-ac5750502eca';
  m    DATE;
BEGIN

  -- ──────────────────────────────────────────────────────────────────────────
  -- RFPL — MONTHLY GSTR-1 (11th of following month) & GSTR-3B (20th)
  -- Remaining FY26-27: Aug-2026 to Mar-2027
  -- ──────────────────────────────────────────────────────────────────────────
  FOR m IN
    SELECT generate_series('2026-08-01'::date, '2027-03-01'::date, '1 month'::interval)
  LOOP
    -- GSTR-1: due 11th of month+1
    INSERT INTO pramaana.compliance_obligations
      (company_id, obligation, period, period_from, period_to, due_date, status)
    VALUES (
      RFPL, 'GSTR-1',
      to_char(m, 'Mon-YYYY'),
      m, (m + INTERVAL '1 month - 1 day')::date,
      (m + INTERVAL '1 month' + INTERVAL '10 days')::date,
      CASE WHEN (m + INTERVAL '1 month' + INTERVAL '10 days')::date < CURRENT_DATE
           THEN 'overdue' ELSE 'upcoming' END
    ) ON CONFLICT DO NOTHING;

    -- GSTR-3B: due 20th of month+1
    INSERT INTO pramaana.compliance_obligations
      (company_id, obligation, period, period_from, period_to, due_date, status)
    VALUES (
      RFPL, 'GSTR-3B',
      to_char(m, 'Mon-YYYY'),
      m, (m + INTERVAL '1 month - 1 day')::date,
      (m + INTERVAL '1 month' + INTERVAL '19 days')::date,
      CASE WHEN (m + INTERVAL '1 month' + INTERVAL '19 days')::date < CURRENT_DATE
           THEN 'overdue' ELSE 'upcoming' END
    ) ON CONFLICT DO NOTHING;
  END LOOP;

  -- ──────────────────────────────────────────────────────────────────────────
  -- TDS DEPOSIT — both companies, 7th of following month
  -- ──────────────────────────────────────────────────────────────────────────
  FOR m IN
    SELECT generate_series('2026-08-01'::date, '2027-03-01'::date, '1 month'::interval)
  LOOP
    -- RFPL
    INSERT INTO pramaana.compliance_obligations
      (company_id, obligation, period, period_from, period_to, due_date, status)
    VALUES (
      RFPL, 'TDS-deposit',
      to_char(m, 'Mon-YYYY'),
      m, (m + INTERVAL '1 month - 1 day')::date,
      (m + INTERVAL '1 month' + INTERVAL '6 days')::date,
      'upcoming'
    ) ON CONFLICT DO NOTHING;

    -- RHHF
    INSERT INTO pramaana.compliance_obligations
      (company_id, obligation, period, period_from, period_to, due_date, status)
    VALUES (
      RHHF, 'TDS-deposit',
      to_char(m, 'Mon-YYYY'),
      m, (m + INTERVAL '1 month - 1 day')::date,
      (m + INTERVAL '1 month' + INTERVAL '6 days')::date,
      'upcoming'
    ) ON CONFLICT DO NOTHING;
  END LOOP;

  -- ──────────────────────────────────────────────────────────────────────────
  -- 26Q — both companies, quarterly
  -- Q1: due 31-Jul (status: overdue — passed); Q2: 31-Oct; Q3: 31-Jan; Q4: 31-May
  -- ──────────────────────────────────────────────────────────────────────────
  -- Q1 FY26-27 (Apr-Jun 2026) — already past due
  INSERT INTO pramaana.compliance_obligations
    (company_id, obligation, period, period_from, period_to, due_date, status, notes)
  VALUES
    (RFPL, '26Q', 'Q1 FY26-27', '2026-04-01', '2026-06-30', '2026-07-31', 'overdue', NULL),
    (RHHF, '26Q', 'Q1 FY26-27', '2026-04-01', '2026-06-30', '2026-07-31', 'overdue',
     'Challan 04-Jun-2026 CIN 26060400165918HDFC backfilled. 26Q filing pending.')
  ON CONFLICT DO NOTHING;

  -- Q2 FY26-27 (Jul-Sep 2026)
  INSERT INTO pramaana.compliance_obligations
    (company_id, obligation, period, period_from, period_to, due_date, status)
  VALUES
    (RFPL, '26Q', 'Q2 FY26-27', '2026-07-01', '2026-09-30', '2026-10-31', 'upcoming'),
    (RHHF, '26Q', 'Q2 FY26-27', '2026-07-01', '2026-09-30', '2026-10-31', 'upcoming')
  ON CONFLICT DO NOTHING;

  -- Q3 FY26-27 (Oct-Dec 2026)
  INSERT INTO pramaana.compliance_obligations
    (company_id, obligation, period, period_from, period_to, due_date, status)
  VALUES
    (RFPL, '26Q', 'Q3 FY26-27', '2026-10-01', '2026-12-31', '2027-01-31', 'upcoming'),
    (RHHF, '26Q', 'Q3 FY26-27', '2026-10-01', '2026-12-31', '2027-01-31', 'upcoming')
  ON CONFLICT DO NOTHING;

  -- Q4 FY26-27 (Jan-Mar 2027)
  INSERT INTO pramaana.compliance_obligations
    (company_id, obligation, period, period_from, period_to, due_date, status)
  VALUES
    (RFPL, '26Q', 'Q4 FY26-27', '2027-01-01', '2027-03-31', '2027-05-31', 'upcoming'),
    (RHHF, '26Q', 'Q4 FY26-27', '2027-01-01', '2027-03-31', '2027-05-31', 'upcoming')
  ON CONFLICT DO NOTHING;

  -- ──────────────────────────────────────────────────────────────────────────
  -- RHHF — QRMP QUARTERLY (GSTR-1 13th after quarter, GSTR-3B 22nd after quarter)
  -- Kerala = Category I state (22nd GSTR-3B)
  -- Remaining quarters: Q2 (Jul-Sep), Q3 (Oct-Dec), Q4 (Jan-Mar)
  -- ──────────────────────────────────────────────────────────────────────────
  INSERT INTO pramaana.compliance_obligations
    (company_id, obligation, period, period_from, period_to, due_date, status, notes)
  VALUES
    -- Q2
    (RHHF, 'GSTR-1', 'Q2 FY26-27 (QRMP)', '2026-07-01', '2026-09-30', '2026-10-13', 'upcoming',
     'QRMP quarterly GSTR-1. IFF (Invoice Furnishing Facility) optional for M1/M2.'),
    (RHHF, 'GSTR-3B', 'Q2 FY26-27 (QRMP)', '2026-07-01', '2026-09-30', '2026-10-22', 'upcoming',
     'QRMP quarterly GSTR-3B. Kerala = 22nd (Category I).'),
    -- Q3
    (RHHF, 'GSTR-1', 'Q3 FY26-27 (QRMP)', '2026-10-01', '2026-12-31', '2027-01-13', 'upcoming', NULL),
    (RHHF, 'GSTR-3B', 'Q3 FY26-27 (QRMP)', '2026-10-01', '2026-12-31', '2027-01-22', 'upcoming', NULL),
    -- Q4
    (RHHF, 'GSTR-1', 'Q4 FY26-27 (QRMP)', '2027-01-01', '2027-03-31', '2027-04-13', 'upcoming', NULL),
    (RHHF, 'GSTR-3B', 'Q4 FY26-27 (QRMP)', '2027-01-01', '2027-03-31', '2027-04-22', 'upcoming', NULL)
  ON CONFLICT DO NOTHING;

  -- ──────────────────────────────────────────────────────────────────────────
  -- RFPL — ROC / IT deadlines (FY26-27)
  -- ──────────────────────────────────────────────────────────────────────────
  INSERT INTO pramaana.compliance_obligations
    (company_id, obligation, period, period_from, period_to, due_date, status, notes)
  VALUES
    (RFPL, 'AGM', 'FY25-26', '2025-04-01', '2026-03-31', '2026-09-30', 'upcoming',
     'AGM for FY25-26 accounts. AOC-4 within 30 days of AGM; MGT-7 within 60 days.'),
    (RFPL, 'AOC-4', 'FY25-26', '2025-04-01', '2026-03-31', '2026-10-30', 'upcoming',
     'Due 30 days after AGM. Assumes AGM on 30-Sep-2026.'),
    (RFPL, 'MGT-7', 'FY25-26', '2025-04-01', '2026-03-31', '2026-11-29', 'upcoming',
     'Due 60 days after AGM. Assumes AGM on 30-Sep-2026.'),
    (RFPL, 'DIR-3-KYC', 'FY25-26', '2025-04-01', '2026-03-31', '2026-09-30', 'upcoming',
     'Annual DIR-3 KYC for all directors. Web form by 30-Sep.'),
    (RFPL, 'ITR', 'FY25-26', '2025-04-01', '2026-03-31', '2026-10-31', 'upcoming',
     'ITR-6 for pvt ltd company with tax audit applicability.'),
    (RFPL, '44AB', 'FY25-26', '2025-04-01', '2026-03-31', '2026-10-31', 'upcoming',
     'Tax audit report (Form 3CA/3CD) — same deadline as ITR when audit applicable.')
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'FY26-27 compliance obligations seeded for RFPL and RHHF';
END;
$$;

-- ── Helper view: next 10 upcoming/overdue per company ─────────────────────────

CREATE OR REPLACE VIEW pramaana.v_compliance_upcoming AS
SELECT
    co.company_id,
    c.code   AS company_code,
    co.obligation,
    co.period,
    co.due_date,
    co.status,
    co.filed_ref,
    co.notes,
    (co.due_date - CURRENT_DATE) AS days_until_due
FROM  pramaana.compliance_obligations co
JOIN  registry.companies c ON c.id = co.company_id
WHERE co.status IN ('upcoming','in_progress','overdue')
ORDER BY co.due_date ASC;

COMMENT ON VIEW pramaana.v_compliance_upcoming IS
  'All pending obligations ordered by due date. Negative days_until_due = overdue.';
