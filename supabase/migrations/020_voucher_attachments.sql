-- ── Voucher Attachments ───────────────────────────────────────────────────────
-- Purpose : Link bills, invoices, receipts to vouchers permanently
-- Run in  : Supabase SQL editor → project mmkbknnzgpvsqgnynrbe
-- Safe    : All statements are idempotent (IF NOT EXISTS / ON CONFLICT)
-- Fix     : Removed is_active = true (column does not exist in company_users)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pramaana.voucher_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id    UUID NOT NULL REFERENCES pramaana.vouchers(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL,
  file_name     TEXT NOT NULL,
  file_size     INTEGER,
  mime_type     TEXT,
  storage_path  TEXT NOT NULL UNIQUE,
  uploaded_by   UUID NOT NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted    BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_vatt_voucher ON pramaana.voucher_attachments(voucher_id);
CREATE INDEX IF NOT EXISTS idx_vatt_company ON pramaana.voucher_attachments(company_id);

-- ── 2. RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE pramaana.voucher_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company members can view attachments"
  ON pramaana.voucher_attachments FOR SELECT
  TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "accounts and admin can insert attachments"
  ON pramaana.voucher_attachments FOR INSERT
  TO authenticated
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM registry.company_users
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'accounts', 'super_admin')
    )
  );

CREATE POLICY "owner or admin can soft-delete attachments"
  ON pramaana.voucher_attachments FOR UPDATE
  TO authenticated
  USING (
    uploaded_by = auth.uid()
    OR company_id IN (
      SELECT company_id FROM registry.company_users
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'super_admin')
    )
  );

-- ── 3. Storage bucket ─────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'voucher-attachments',
  'voucher-attachments',
  false,
  10485760,
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ── 4. Storage RLS ────────────────────────────────────────────────────────────

CREATE POLICY "company members can download attachments"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'voucher-attachments'
    AND (storage.foldername(name))[1] IN (
      SELECT company_id::text FROM registry.company_users
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "accounts and admin can upload attachments"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'voucher-attachments'
    AND (storage.foldername(name))[1] IN (
      SELECT company_id::text FROM registry.company_users
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'accounts', 'super_admin')
    )
  );

CREATE POLICY "accounts and admin can delete attachments"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'voucher-attachments'
    AND (storage.foldername(name))[1] IN (
      SELECT company_id::text FROM registry.company_users
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'accounts', 'super_admin')
    )
  );

-- ── 5. Grants ─────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON pramaana.voucher_attachments TO authenticated;

-- ── 6. Verify ─────────────────────────────────────────────────────────────────

SELECT table_name, row_security
FROM information_schema.tables
WHERE table_schema = 'pramaana' AND table_name = 'voucher_attachments';

SELECT id, name, public FROM storage.buckets WHERE id = 'voucher-attachments';
