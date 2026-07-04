-- ── Bill Attachments Bucket ───────────────────────────────────────────────────
-- Migration: 050_bill_attachments_bucket.sql
-- Creates the `bill-attachments` storage bucket used by the Invoice Scan module.
-- The 20260625000000_invoice_scan_module.sql migration created the tables but
-- omitted the bucket creation — this migration fills that gap.
-- Safe: ON CONFLICT DO NOTHING + CREATE POLICY IF NOT EXISTS

-- ── Bucket ────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'bill-attachments',
  'bill-attachments',
  false,
  10485760,   -- 10 MB
  ARRAY[
    'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
    'image/heic', 'image/heif',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ── Storage RLS ───────────────────────────────────────────────────────────────

-- PostgreSQL does not support CREATE POLICY IF NOT EXISTS — use DO blocks.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'authenticated users can upload bill attachments'
  ) THEN
    CREATE POLICY "authenticated users can upload bill attachments"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'bill-attachments');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'authenticated users can read bill attachments'
  ) THEN
    CREATE POLICY "authenticated users can read bill attachments"
      ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'bill-attachments');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'authenticated users can delete bill attachments'
  ) THEN
    CREATE POLICY "authenticated users can delete bill attachments"
      ON storage.objects FOR DELETE
      TO authenticated
      USING (bucket_id = 'bill-attachments');
  END IF;
END $$;
