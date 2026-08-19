/**
 * POST /api/receipt-upload
 * Accepts a base64-encoded payment receipt, deduplicates by sha256,
 * uploads to private 'receipts' bucket, inserts receipt_inbox row,
 * then fire-and-forgets receipt-extract. Returns in <2s always.
 *
 * Body: { fileBase64: string, fileName: string, fileType: string }
 */
import crypto from 'node:crypto'

export const config = { maxDuration: 30 }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function env(k: string): string { return ((globalThis as any)?.process?.env?.[k] as string) ?? '' }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = env('VITE_SUPABASE_URL')
  const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

  // ── Auth ────────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401)
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: authHeader },
  })
  if (!userRes.ok) return json({ error: 'Unauthorized' }, 401)
  const { id: userId } = await userRes.json() as { id: string }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: { fileBase64?: string; fileName?: string; fileType?: string }
  try { body = await req.json() as typeof body } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { fileBase64, fileName, fileType } = body
  if (!fileBase64 || !fileName) return json({ error: 'fileBase64 and fileName required' }, 400)
  if (fileBase64.length > 14_000_000) return json({ error: 'File exceeds 10 MB limit' }, 413)

  const mime = fileType ?? 'image/jpeg'
  const bytes = Buffer.from(fileBase64, 'base64')
  const fileHash = crypto.createHash('sha256').update(bytes).digest('hex')

  const headers = {
    apikey:            serviceKey,
    Authorization:     `Bearer ${serviceKey}`,
    'Content-Type':    'application/json',
    'Accept-Profile':  'pramaana',
    'Content-Profile': 'pramaana',
  }

  // ── Deduplicate ─────────────────────────────────────────────────────────────
  const dupRes = await fetch(
    `${supabaseUrl}/rest/v1/receipt_inbox?file_hash=eq.${fileHash}&select=id,status`,
    { headers },
  )
  if (dupRes.ok) {
    const rows = await dupRes.json() as { id: string; status: string }[]
    if (rows.length > 0) return json({ duplicate: true, id: rows[0].id, status: rows[0].status }, 200)
  }

  // ── Upload to storage ───────────────────────────────────────────────────────
  const now = new Date()
  const yyyy = now.getUTCFullYear()
  const mm   = String(now.getUTCMonth() + 1).padStart(2, '0')
  const ext  = mime.includes('pdf') ? 'pdf' : (mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg')
  const inboxId = crypto.randomUUID()
  const filePath = `inbox/${yyyy}/${mm}/${inboxId}.${ext}`

  const uploadRes = await fetch(
    `${supabaseUrl}/storage/v1/object/receipts/${filePath}`,
    {
      method:  'POST',
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${serviceKey}`,
        'Content-Type': mime,
      },
      body: bytes,
    },
  )
  if (!uploadRes.ok) {
    const err = await uploadRes.text()
    return json({ error: `Storage upload failed: ${err}` }, 500)
  }

  // ── Insert receipt_inbox ────────────────────────────────────────────────────
  const insertRes = await fetch(`${supabaseUrl}/rest/v1/receipt_inbox`, {
    method:  'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({
      id:         inboxId,
      file_path:  filePath,
      file_hash:  fileHash,
      mime_type:  mime,
      shared_by:  userId,
      status:     'received',
    }),
  })
  if (!insertRes.ok) return json({ error: `DB insert failed: ${await insertRes.text()}` }, 500)

  // ── Fire-and-forget OCR extraction (no await — must return in <2s) ──────────
  const host = req.headers.get('host') ?? 'pramaana-tau.vercel.app'
  fetch(`https://${host}/api/receipt-extract`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body:    JSON.stringify({ id: inboxId, fileBase64, fileType: mime }),
  }).catch(() => { /* best-effort */ })

  return json({ id: inboxId, status: 'received' }, 200)
}
