-- ════════════════════════════════════════════════════════════════════════════
-- 095_receipt_inbox.sql — Receipt Inbox for Direct-Share payment evidence
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pramaana.receipt_inbox (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID        REFERENCES registry.companies(id),     -- NULL until matched
  status           TEXT        NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received','extracted','suggested',
                                     'needs_assignment','confirmed','attached','discarded')),
  file_path        TEXT        NOT NULL,
  file_hash        TEXT        NOT NULL,                               -- sha256, dedup key
  mime_type        TEXT        NOT NULL,
  shared_by        UUID        NOT NULL,                               -- auth.users.id
  -- OCR results (null until extracted)
  ocr_utr          TEXT,
  ocr_amount       NUMERIC(14,2),
  ocr_date         DATE,
  ocr_payee_hint   TEXT,
  ocr_account_hint TEXT,
  ocr_raw          JSONB,
  -- resolution
  suggested_voucher_id   UUID REFERENCES pramaana.vouchers(id),
  suggestion_confidence  TEXT CHECK (suggestion_confidence IN ('high','medium','low')),
  attached_voucher_id    UUID REFERENCES pramaana.vouchers(id),
  confirmed_by           UUID,
  confirmed_at           TIMESTAMPTZ,
  amount_delta           NUMERIC(14,2),
  auto_matched           BOOLEAN     NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_inbox_hash
  ON pramaana.receipt_inbox (file_hash);

CREATE INDEX IF NOT EXISTS ix_receipt_inbox_status
  ON pramaana.receipt_inbox (status);

CREATE INDEX IF NOT EXISTS ix_receipt_inbox_shared_by
  ON pramaana.receipt_inbox (shared_by, created_at DESC);

ALTER TABLE pramaana.receipt_inbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS receipt_inbox_select ON pramaana.receipt_inbox;
CREATE POLICY receipt_inbox_select ON pramaana.receipt_inbox
  FOR SELECT TO authenticated
  USING (
    shared_by = auth.uid()
    OR (company_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM registry.company_users cu
          WHERE cu.user_id = auth.uid()
            AND cu.company_id = receipt_inbox.company_id))
    OR (company_id IS NULL AND EXISTS (
          SELECT 1 FROM registry.company_users cu
          WHERE cu.user_id = auth.uid()
            AND cu.role IN ('accounts','admin','super_admin')))
  );

DROP POLICY IF EXISTS receipt_inbox_service ON pramaana.receipt_inbox;
CREATE POLICY receipt_inbox_service ON pramaana.receipt_inbox
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON pramaana.receipt_inbox TO authenticated;
GRANT ALL    ON pramaana.receipt_inbox TO service_role;

-- ── Guard: one UTR per company (prevents double-attach of same payment) ───────
-- Deduplicate first: null out utr_number on non-posted older duplicates.
-- Posted/cancelled vouchers are immutable (fn_prevent_posted_edit trigger)
-- so we can't touch them; if posted duplicates remain after this step, the
-- index creation is skipped with a WARNING rather than failing the migration.
DO $dedup$
BEGIN
  UPDATE pramaana.vouchers
  SET    utr_number = NULL
  WHERE  id IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY company_id, utr_number
               -- keep posted vouchers over non-posted, then newest first
               ORDER BY CASE WHEN status = 'posted' THEN 0 ELSE 1 END,
                        created_at DESC, id DESC
             ) AS rn
      FROM   pramaana.vouchers
      WHERE  utr_number IS NOT NULL
    ) ranked
    WHERE rn > 1
  )
  AND status NOT IN ('posted', 'cancelled');

  BEGIN
    CREATE UNIQUE INDEX uq_vouchers_utr
      ON pramaana.vouchers (company_id, utr_number)
      WHERE utr_number IS NOT NULL;
  EXCEPTION WHEN unique_violation THEN
    RAISE WARNING
      'uq_vouchers_utr NOT created — duplicate UTRs remain on posted vouchers. '
      'Diagnose with: SELECT company_id, utr_number, count(*) '
      'FROM pramaana.vouchers WHERE utr_number IS NOT NULL '
      'GROUP BY 1,2 HAVING count(*)>1;';
  END;
END $dedup$;

-- ── Storage bucket (private, 10 MB limit) ────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'receipts', 'receipts', false, 10485760,
  ARRAY['image/jpeg','image/jpg','image/png','image/webp','image/heic','application/pdf']
) ON CONFLICT (id) DO NOTHING;

-- Service role manages all receipt objects
DROP POLICY IF EXISTS receipts_service ON storage.objects;
CREATE POLICY receipts_service ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'receipts') WITH CHECK (bucket_id = 'receipts');
