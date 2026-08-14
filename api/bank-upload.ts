/**
 * Vercel Edge Function — bank statement upload.
 * POST /api/bank-upload
 *
 * Body: { company_id, bank_code, period_from, period_to, file_name, file_type, file_base64 }
 *
 * Flow:
 *   1. Validate session + company membership
 *   2. Create bank_statements record → get statement_id
 *   3. Upload file to bank-statements bucket (storage path: {company_id}/{statement_id}/{file_name})
 *   4. Update bank_statements.storage_path
 *   5. Return { statement_id } — caller triggers /api/bank-parse next
 *
 * Errors: 400 validation | 403 auth | 404 bank_code | 409 period overlap | 500 storage
 */

export const config = { runtime: 'edge' }

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

function env(name: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((globalThis as any)?.process?.env?.[name] as string) ?? ''
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: {
    company_id?: string
    bank_code?: string
    period_from?: string
    period_to?: string
    file_name?: string
    file_type?: string
    file_base64?: string
  }
  try {
    body = await req.json() as typeof body
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const { company_id, bank_code, period_from, period_to, file_name, file_type, file_base64 } = body

  if (!company_id || !bank_code || !period_from || !period_to || !file_name || !file_base64) {
    return json({ error: 'Missing required fields: company_id, bank_code, period_from, period_to, file_name, file_base64' }, 400)
  }

  const supabaseUrl = env('VITE_SUPABASE_URL')
  const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server not configured' }, 500)
  }

  // ── Auth header passthrough ─────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 403)

  // Verify user belongs to the claimed company
  const memberRes = await fetch(
    `${supabaseUrl}/rest/v1/company_users?user_id=eq.${encodeURIComponent(authHeader.slice(7))}&company_id=eq.${company_id}&select=role`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Accept-Profile': 'registry',
      },
    },
  )
  // Use service-role JWT to decode user id from the passed token instead
  // Simplified: validate by calling Supabase auth/user endpoint
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: authHeader },
  })
  if (!userRes.ok) return json({ error: 'Unauthorized' }, 403)
  const { id: user_id } = await userRes.json() as { id: string }

  // Check company membership with accounts or admin role
  const cuRes = await fetch(
    `${supabaseUrl}/rest/v1/company_users?user_id=eq.${user_id}&company_id=eq.${company_id}&role=in.(admin,accounts)&select=id`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Accept-Profile': 'registry',
      },
    },
  )

  // Also allow super_admin
  const profileRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${user_id}&is_super_admin=eq.true&select=id`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Accept-Profile': 'registry',
      },
    },
  )

  const cuRows = cuRes.ok ? await cuRes.json() as unknown[] : []
  const profileRows = profileRes.ok ? await profileRes.json() as unknown[] : []
  if (!cuRows.length && !profileRows.length) {
    return json({ error: 'Forbidden: accounts or admin role required' }, 403)
  }

  // ── Resolve bank_format_config ─────────────────────────────────────────────
  const bfcRes = await fetch(
    `${supabaseUrl}/rest/v1/bank_format_config?bank_code=eq.${encodeURIComponent(bank_code)}&company_id=eq.${company_id}&select=id,active`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Accept-Profile': 'pramaana',
      },
    },
  )
  const bfcRows = bfcRes.ok ? await bfcRes.json() as { id: string; active: boolean }[] : []
  if (!bfcRows.length) return json({ error: `Bank config not found for bank_code: ${bank_code}` }, 404)
  if (!bfcRows[0].active) return json({ error: `Bank config for ${bank_code} is not yet active (fixture not uploaded/verified)` }, 400)
  const bank_format_id = bfcRows[0].id

  // ── Check period overlap ───────────────────────────────────────────────────
  const overlapRes = await fetch(
    `${supabaseUrl}/rest/v1/bank_statements?company_id=eq.${company_id}&bank_format_id=eq.${bank_format_id}&period_from=lte.${period_to}&period_to=gte.${period_from}&status=neq.uploaded&select=id`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Accept-Profile': 'pramaana',
      },
    },
  )
  const overlapRows = overlapRes.ok ? await overlapRes.json() as unknown[] : []
  if (overlapRows.length) {
    return json({ error: 'A statement for this bank and period already exists. Delete it first.' }, 409)
  }

  // ── Create bank_statements record ─────────────────────────────────────────
  const insertRes = await fetch(`${supabaseUrl}/rest/v1/bank_statements`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Profile': 'pramaana',
      'Content-Type':    'application/json',
      Prefer:            'return=representation',
    },
    body: JSON.stringify({
      company_id,
      bank_format_id,
      raw_content:   file_base64,
      period_from,
      period_to,
      uploaded_by:   user_id,
      status:        'uploaded',
    }),
  })

  if (!insertRes.ok) {
    const err = await insertRes.text()
    return json({ error: `Failed to create statement record: ${err}` }, 500)
  }
  const [stmt] = await insertRes.json() as { id: string }[]
  const statement_id = stmt.id

  return json({ statement_id })
}
