-- ════════════════════════════════════════════════════════════════════════════
-- 092_backfill_entity_upi_ids.sql
--
-- Backfills UPI IDs (and missing bank details) into registry.entity_bank_accounts
-- from the Relish Approvals payee export (RHHF + RFPL, exported 2026-08-18).
--
-- Source: RelishApprovals Supabase project (ap-southeast-2 / Sydney) —
--   a separate database; UUIDs differ. Matching is by lower(trim(display_name)).
--
-- Safety: COALESCE in DO UPDATE ensures existing non-null values are never
--   overwritten. Unmatched names produce no rows and no error.
-- ════════════════════════════════════════════════════════════════════════════

WITH src (nm, upi, acct, ifsc, bank) AS (
  VALUES
    -- A
    ('a1 travels and speed parcel service',      '8921724565@slc',            NULL,               NULL,          NULL),
    ('abin peter',                                'peterabin847-2@okaxis',     NULL,               NULL,          NULL),
    ('able traddelinks',                          'abletradelinks@oksbi',      NULL,               NULL,          NULL),
    ('alif hardware 26- 27',                      'alpytechnocare1@fbi',       NULL,               NULL,          NULL),
    ('ashraf',                                    'ashreerf859@okicici',       NULL,               NULL,          NULL),
    -- B
    ('balachandran m n',                          'baijuantony942@oksbi',      NULL,               NULL,          NULL),
    ('binoy',                                     'bejoys0808-2@okicici',      NULL,               NULL,          NULL),
    -- G-J
    ('goodmorning enterprises',                   'goodmorning00@fbi',         '10155000002894',   'FDRL0001015', NULL),
    ('home ceramica',                             'q700014173@ybl',            NULL,               NULL,          NULL),
    ('jacab john & co',                           '33586026093656541@cnrb',    NULL,               NULL,          NULL),
    ('jayakumar b',                               'jbpanikker-1@oksbi',        NULL,               NULL,          NULL),
    -- M
    ('mahadeva electricals & sanitary',           '12239250800021390@cnrb',    NULL,               NULL,          NULL),
    ('manikumar',                                 '9787249383-2@ybl',          NULL,               NULL,          NULL),
    ('manu',                                      'muralidhararanmanu94@okaxis',NULL,              NULL,          NULL),
    ('manu antony',                               'manuantony230@okicici',     NULL,               NULL,          NULL),
    ('max metals & hardwares',                    'paytmqr1f9rh0hni0@paytm',  NULL,               NULL,          NULL),
    ('mohammed shafi',                            '1990shafi@okaxis',          NULL,               NULL,          NULL),
    ('mss transport',                             'msslogistics@okicici',      NULL,               NULL,          NULL),
    ('mullasseri hardwares',                      'mullasserinaz@okicici',     NULL,               NULL,          NULL),
    -- N
    ('neelakandan saw mill',                      'shylasudarsansn@oksbi',     NULL,               NULL,          NULL),
    ('new rajasthan marbles',                     'Q523794325@ybl',            '336801010310537',  'UBIN0533688', NULL),
    ('niram paints',                              'paytmqr1dsl074pus@paytm',   NULL,               NULL,          NULL),
    ('nivetha tex',                               'paytmrdsl0174pus@paytm',    NULL,               NULL,          NULL),
    -- R  (Renjith = Mitra Constructions in relish_suite — same bank account confirmed)
    ('renjith',                                   '9847056752.1@hdfc',         NULL,               NULL,          NULL),
    ('reji',                                      'rejimonhamsa-1@oksbi',      NULL,               NULL,          NULL),
    ('robin',                                     'r2729640@okicici',          NULL,               NULL,          NULL),
    -- S
    ('sangeetha stalin',                          'sangeethavino1@oksbi',      NULL,               NULL,          NULL),
    ('sara living solutions',                     '974522415m@pnb',            '7494008700000669', 'PUNB0749400', NULL),
    ('sebin jose',                                'sebinjose480@okaxis',       NULL,               NULL,          NULL),
    ('shameer transportation',                    'siddiqueshameer970@oksbi',  NULL,               NULL,          NULL),
    ('sherine motty',                             'sherlinemotty@okaxis',      NULL,               NULL,          NULL),
    ('shibu kb',                                  'abhisheksmani944619@oksbi', NULL,               NULL,          NULL),
    ('shree krishna sheets & pipes',              'sibypuzhakkara@oksbi',      NULL,               NULL,          NULL),
    ('sibi',                                      'sibypuzhakkara@oksbi',      NULL,               NULL,          NULL),
    ('sundaran kv',                               'kvsundaran182@oksbi',       NULL,               NULL,          NULL),
    ('syam kumar',                                'sunny2089@okicici',         NULL,               NULL,          NULL),
    -- T
    ('tarun philip',                              'tarunphilip2308@okhdfcbank',NULL,               NULL,          NULL),
    ('thiruvonam agencies',                       'thiruvonamagen1@fbl',       NULL,               NULL,          NULL),
    ('tranzet technolabs private lmt',            'tranzet@ucobank',           NULL,               NULL,          NULL),
    ('twinsquad essentials pvt ltd',              'Q3049564523@ybl',           NULL,               NULL,          NULL)
),
matched AS (
  SELECT e.id AS entity_id, s.upi, s.acct, s.ifsc, s.bank
  FROM   src s
  JOIN   registry.entities e ON lower(trim(e.display_name)) = s.nm
)
INSERT INTO registry.entity_bank_accounts
  (entity_id, label, upi_id, bank_account_number, bank_ifsc, bank_name, is_primary, is_active)
SELECT entity_id, 'Primary', upi, acct, ifsc, bank, true, true
FROM   matched
ON CONFLICT (entity_id) WHERE is_primary = true AND is_active = true
DO UPDATE SET
  upi_id              = COALESCE(EXCLUDED.upi_id,              entity_bank_accounts.upi_id),
  bank_account_number = COALESCE(EXCLUDED.bank_account_number, entity_bank_accounts.bank_account_number),
  bank_ifsc           = COALESCE(EXCLUDED.bank_ifsc,           entity_bank_accounts.bank_ifsc),
  bank_name           = COALESCE(EXCLUDED.bank_name,           entity_bank_accounts.bank_name);

-- ── Verification query (run after, don't include in migration) ───────────────
-- SELECT e.display_name, eba.upi_id, eba.bank_account_number, eba.bank_ifsc
-- FROM registry.entity_bank_accounts eba
-- JOIN registry.entities e ON e.id = eba.entity_id
-- WHERE eba.upi_id IS NOT NULL
-- ORDER BY e.display_name;
