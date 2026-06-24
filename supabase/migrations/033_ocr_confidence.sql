-- ── OCR Confidence & Source columns for pramaana.vouchers ──────────────────────
-- Adds metadata for vouchers created via Invoice OCR scan.
-- Safe: IF NOT EXISTS / USING cast ensures idempotency.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pramaana.vouchers
  ADD COLUMN IF NOT EXISTS ocr_confidence numeric(5,2),
  ADD COLUMN IF NOT EXISTS source text
    DEFAULT 'manual'
    CHECK (source IN ('manual', 'ocr'));

-- Back-fill existing rows (all were created manually)
UPDATE pramaana.vouchers
  SET source = 'manual'
  WHERE source IS NULL;

-- Index for filtering OCR-sourced vouchers
CREATE INDEX IF NOT EXISTS idx_vouchers_source
  ON pramaana.vouchers (source)
  WHERE source = 'ocr';

COMMENT ON COLUMN pramaana.vouchers.ocr_confidence IS
  'Average Textract field confidence (0–100) when source = ''ocr''. NULL for manual vouchers.';

COMMENT ON COLUMN pramaana.vouchers.source IS
  'Origin of the voucher: ''manual'' (entered by user) or ''ocr'' (created via Invoice Scan).';
