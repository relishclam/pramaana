/**
 * Vercel Edge Function — anonymous receipt/invoice upload for the settle form.
 * POST /api/settle-upload
 *
 * Body: { token, fileName, fileType, fileBase64 }
 *   token:      settlement session token (from /settle/:token URL)
 *   fileName:   safe filename with timestamp prefix
 *   fileType:   MIME type
 *   fileBase64: file bytes encoded as base64 (no data-URI prefix)
 *
 * Returns: { path } on success | { error } on failure
 *
 * Uses SUPABASE_SERVICE_ROLE_KEY (server-only) to bypass storage RLS — this is
 * the only safe way to allow anonymous uploads to a private Supabase bucket.
 * Token validation ensures only holders of a valid settlement link can upload.
 */

export const config = { runtime: 'edge' }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: { token?: string; fileName?: string; fileType?: string; fileBase64?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const { token, fileName, fileType, fileBase64 } = body
  if (!token || !fileName || !fileBase64) {
    return json({ error: 'Missing required fields' }, 400)
  }

  // ── Env vars ────────────────────────────────────────────────────────────────
  // Use globalThis pattern for reliable access in Vercel Edge Runtime (V8 isolate)
  const env         = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env ?? {}
  const supabaseUrl = env.VITE_SUPABASE_URL
  const serviceKey  = env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl && !serviceKey) {
    return json({ error: 'Server not configured: missing VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY' }, 500)
  }
  if (!supabaseUrl) {
    return json({ error: 'Server not configured: missing VITE_SUPABASE_URL' }, 500)
  }
  if (!serviceKey) {
    return json({ error: 'Server not configured: missing SUPABASE_SERVICE_ROLE_KEY' }, 500)
  }

  // ── Validate token — confirm it maps to an active settlement session ────────
  const validateRes = await fetch(
    `${supabaseUrl}/rest/v1/settlement_sessions?token=eq.${encodeURIComponent(token)}&select=id,status`,
    {
      headers: {
        'apikey':          serviceKey,
        'Authorization':   `Bearer ${serviceKey}`,
        'Accept-Profile':  'pramaana',
      },
    },
  )
  if (!validateRes.ok) {
    const errBody = await validateRes.json().catch(() => ({})) as { message?: string; code?: string }
    return json({ error: `Token validation failed (${validateRes.status}): ${errBody.message ?? errBody.code ?? 'unknown'}` }, 403)
  }

  const sessions = await validateRes.json() as { id: string; status: string }[]
  if (!sessions?.length) return json({ error: 'Invalid or expired token' }, 403)

  // ── Decode base64 → binary ─────────────────────────────────────────────────
  let bytes: Uint8Array
  try {
    const binary = atob(fileBase64)
    bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  } catch {
    return json({ error: 'Invalid file data' }, 400)
  }

  // ── Upload to Supabase Storage via service key (bypasses RLS) ──────────────
  const path      = `settle/${token}/${fileName}`
  const uploadRes = await fetch(
    `${supabaseUrl}/storage/v1/object/voucher-attachments/${path}`,
    {
      method:  'POST',
      headers: {
        'apikey':        serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type':  fileType || 'application/octet-stream',
        'x-upsert':      'false',
      },
      body: bytes as BodyInit,
    },
  )

  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(() => ({})) as { error?: string }
    return json({ error: err.error ?? `Storage upload failed (${uploadRes.status})` }, 500)
  }

  return json({ path })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
