-- ── Attachment Type ────────────────────────────────────────────────────────────
-- Purpose : Distinguish invoice/bill attachments from transfer receipts
-- Safe    : Idempotent — uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pramaana.voucher_attachments
  ADD COLUMN IF NOT EXISTS attachment_type TEXT NOT NULL DEFAULT 'invoice'
    CONSTRAINT voucher_attachments_type_check
    CHECK (attachment_type IN ('invoice', 'transfer_receipt', 'other'));

COMMENT ON COLUMN pramaana.voucher_attachments.attachment_type IS
  'invoice = bill/invoice attached at entry time; transfer_receipt = bank/UPI transfer receipt uploaded after payment; other = miscellaneous';
