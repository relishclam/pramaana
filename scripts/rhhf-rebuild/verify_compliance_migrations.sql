-- ════════════════════════════════════════════════════════════════════════════
-- verify_compliance_migrations.sql
-- Verifies migrations 084-087 in one result set.
-- ════════════════════════════════════════════════════════════════════════════

SELECT check_name, result, detail FROM (

  -- 084.1 company_statutory seeded
  SELECT '084.1 company_statutory' AS check_name,
    CASE WHEN count(*) = 2 THEN '✓ PASS' ELSE '✗ FAIL — expected 2 rows' END AS result,
    string_agg(c.code || '=' || cs.incorporation_type || '/' || cs.gst_frequency, '  ') AS detail
  FROM registry.company_statutory cs
  JOIN registry.companies c ON c.id = cs.company_id
  WHERE cs.company_id IN (
    'bc455c94-0bcd-4d66-a040-d29ed880d22f',
    'b8beb440-df7f-48e8-a012-ac5750502eca'
  )

  UNION ALL

  -- 084.2 TDS Payable ledgers created for both companies
  SELECT '084.2 TDS Payable ledgers',
    CASE WHEN count(*) = 10 THEN '✓ PASS'
         ELSE '✗ FAIL — expected 10, got ' || count(*)::text END,
    count(*)::text || ' rows (5 sections × 2 companies)'
  FROM pramaana.ledgers
  WHERE name ILIKE 'TDS Payable%'
    AND company_id IN (
      'bc455c94-0bcd-4d66-a040-d29ed880d22f',
      'b8beb440-df7f-48e8-a012-ac5750502eca'
    )

  UNION ALL

  -- 084.3 is_tds_applicable=true on TDS Payable ledgers (the constraint fix)
  SELECT '084.3 TDS flag on payable ledgers',
    CASE WHEN count(*) = 0 THEN '✓ PASS'
         ELSE '✗ FAIL — ' || count(*)::text || ' ledger(s) have section_code but is_tds_applicable=false' END,
    COALESCE(string_agg(name, ', '), 'none')
  FROM pramaana.ledgers
  WHERE name ILIKE 'TDS Payable%'
    AND tds_section_code IS NOT NULL
    AND is_tds_applicable = false

  UNION ALL

  -- 084.4 RHHF challan backfilled
  SELECT '084.4 RHHF Q1 challan',
    CASE WHEN count(*) >= 1 THEN '✓ PASS' ELSE '✗ FAIL — challan not found' END,
    MAX('CIN=' || COALESCE(cin,'null') || '  tax=' || amount_tax::text || '  interest=' || amount_interest::text)
  FROM pramaana.statutory_challans
  WHERE company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
    AND cin = '26060400165918HDFC'

  UNION ALL

  -- 084.5 RHHF party statutory attributes
  SELECT '084.5 RHHF party TDS attrs',
    CASE WHEN count(*) >= 3 THEN '✓ PASS'
         ELSE '✗ FAIL — expected ≥3, got ' || count(*)::text END,
    string_agg(name || '(' || COALESCE(tds_section_default,'exempt=true') || ')', '  ')
  FROM pramaana.ledgers
  WHERE company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
    AND (tds_section_default IS NOT NULL OR tds_exempt = true)

  UNION ALL

  -- 085.1 TDS rules seeded
  SELECT '085.1 tds_rules',
    CASE WHEN count(*) >= 6 THEN '✓ PASS'
         ELSE '✗ FAIL — expected ≥6, got ' || count(*)::text END,
    string_agg(section_code, ', ' ORDER BY section_code)
  FROM pramaana.tds_rules
  WHERE effective_to IS NULL

  UNION ALL

  -- 085.2 194C thresholds correct
  SELECT '085.2 194C thresholds',
    CASE WHEN single_payment_threshold = 30000
          AND aggregate_fy_threshold = 100000
          AND rate_individual = 1.00
          AND rate_company    = 2.00
        THEN '✓ PASS'
        ELSE '✗ FAIL — wrong values' END,
    'single=' || COALESCE(single_payment_threshold::text,'null')
    || ' agg=' || COALESCE(aggregate_fy_threshold::text,'null')
    || ' rate_ind=' || rate_individual::text
    || ' rate_co=' || rate_company::text
  FROM pramaana.tds_rules
  WHERE section_code = '194C' AND effective_to IS NULL

  UNION ALL

  -- 086.1 Compliance obligations seeded
  SELECT '086.1 compliance_obligations',
    CASE WHEN count(*) >= 30 THEN '✓ PASS'
         ELSE '✗ FAIL — expected ≥30, got ' || count(*)::text END,
    'RFPL=' || sum(CASE WHEN company_id = 'bc455c94-0bcd-4d66-a040-d29ed880d22f' THEN 1 ELSE 0 END)::text
    || '  RHHF=' || sum(CASE WHEN company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca' THEN 1 ELSE 0 END)::text
  FROM pramaana.compliance_obligations

  UNION ALL

  -- 086.2 RHHF Q1 26Q correctly marked overdue
  SELECT '086.2 RHHF Q1 26Q overdue',
    CASE WHEN count(*) = 1 THEN '✓ PASS' ELSE '✗ FAIL — row missing or wrong status' END,
    MAX(obligation || ' due=' || due_date::text || ' status=' || status)
  FROM pramaana.compliance_obligations
  WHERE company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
    AND obligation = '26Q'
    AND period = 'Q1 FY26-27'

  UNION ALL

  -- 087.1 compliance_role_access seeded
  SELECT '087.1 role_access rows',
    CASE WHEN count(*) >= 8 THEN '✓ PASS'
         ELSE '✗ FAIL — expected ≥8, got ' || count(*)::text END,
    string_agg(role || '/' || category || (CASE WHEN can_update_status THEN '+upd' ELSE '' END), '  ')
  FROM registry.compliance_role_access

  UNION ALL

  -- 087.2 company_users.role constraint extended
  SELECT '087.2 role constraint includes cs/gst_consultant',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.check_constraints
      WHERE constraint_schema = 'registry'
        AND check_clause ILIKE '%gst_consultant%'
    ) THEN '✓ PASS' ELSE '✗ FAIL — constraint missing new roles' END,
    (SELECT check_clause FROM information_schema.check_constraints
     WHERE constraint_schema = 'registry'
       AND check_clause ILIKE '%gst_consultant%' LIMIT 1)

  UNION ALL

  -- 087.3 accessible_categories function exists
  SELECT '087.3 compliance_accessible_categories()',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.routines
      WHERE routine_schema = 'registry'
        AND routine_name   = 'compliance_accessible_categories'
    ) THEN '✓ PASS' ELSE '✗ FAIL — function not found' END,
    'registry.compliance_accessible_categories(UUID,UUID)'

) t
ORDER BY check_name;
