import { supabase } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

export type AttachmentType = 'invoice' | 'transfer_receipt' | 'other'

export interface VoucherAttachment {
  id:              string
  voucher_id:      string
  company_id:      string
  file_name:       string
  file_size:       number | null
  mime_type:       string | null
  storage_path:    string
  uploaded_by:     string
  uploaded_at:     string
  is_deleted:      boolean
  attachment_type: AttachmentType
}

export interface AttachmentWithUrl extends VoucherAttachment {
  signed_url: string
}

const BUCKET = 'voucher-attachments'

export async function getVoucherAttachmentSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 3600)

  if (error) throw new Error('Failed to sign attachment URL: ' + error.message)
  if (!data?.signedUrl) throw new Error('Attachment URL unavailable')
  return data.signedUrl
}

// ── Upload files for a voucher ────────────────────────────────────────────────
// Called after the voucher is created so we have a real voucher_id.
// Fails gracefully per-file — does not throw if one file fails.

export async function uploadVoucherAttachments(
  voucherId:      string,
  companyId:      string,
  userId:         string,
  files:          File[],
  attachmentType: AttachmentType = 'invoice',
): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[]     = []
  const failed: string[] = []

  for (const file of files) {
    try {
      const ext      = file.name.split('.').pop()?.toLowerCase() ?? 'bin'
      const safeName = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
      const path     = `${companyId}/${voucherId}/${safeName}`

      // Upload to Supabase Storage
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { contentType: file.type, upsert: false })

      if (upErr) { failed.push(file.name); continue }

      // Record in DB
      const { error: dbErr } = await supabase
        .schema('pramaana')
        .from('voucher_attachments')
        .insert({
          voucher_id:      voucherId,
          company_id:      companyId,
          file_name:       file.name,
          file_size:       file.size,
          mime_type:       file.type || null,
          storage_path:    path,
          uploaded_by:     userId,
          attachment_type: attachmentType,
        })

      if (dbErr) {
        // Row failed — clean up orphaned storage file, log and continue
        await supabase.storage.from(BUCKET).remove([path])
        failed.push(file.name)
        continue
      }

      ok.push(file.name)
    } catch {
      failed.push(file.name)
    }
  }

  return { ok, failed }
}

// ── Fetch attachments for a voucher (with signed URLs) ────────────────────────

export async function fetchVoucherAttachments(
  voucherId: string,
): Promise<AttachmentWithUrl[]> {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('voucher_attachments')
    .select('*')
    .eq('voucher_id', voucherId)
    .eq('is_deleted', false)
    .order('uploaded_at')

  if (error) throw new Error('Failed to load attachments: ' + error.message)
  const rows = (data ?? []) as VoucherAttachment[]
  if (rows.length === 0) return []

  // Batch-generate signed URLs (1-hour expiry)
  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(rows.map(r => r.storage_path), 3600)

  if (signErr) throw new Error('Failed to sign attachment URLs: ' + signErr.message)

  const urlMap = new Map((signed ?? []).map(s => [s.path, s.signedUrl ?? '']))

  // Some objects can intermittently return empty signedUrl in batch mode.
  // Fallback to single-object signing so UI links always work when possible.
  const enriched = await Promise.all(rows.map(async (r) => {
    let signedUrl = urlMap.get(r.storage_path) ?? ''
    if (!signedUrl) {
      try {
        signedUrl = await getVoucherAttachmentSignedUrl(r.storage_path)
      } catch {
        signedUrl = ''
      }
    }

    return {
      ...r,
      signed_url: signedUrl,
    }
  }))

  return enriched
}

// ── Soft-delete an attachment ─────────────────────────────────────────────────

export async function deleteAttachment(attachmentId: string): Promise<void> {
  const { error } = await supabase
    .schema('pramaana')
    .from('voucher_attachments')
    .update({ is_deleted: true })
    .eq('id', attachmentId)

  if (error) throw new Error('Failed to delete attachment: ' + error.message)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isImage(mimeType: string | null): boolean {
  return !!mimeType?.startsWith('image/')
}

export function formatFileSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024)       return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
