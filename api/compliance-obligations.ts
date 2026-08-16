/**
 * GET  /api/compliance-obligations?company_id=...&status=upcoming&limit=20
 * GET  /api/compliance-obligations?company_id=...&id=...
 * POST /api/compliance-obligations        — create obligation
 * PATCH /api/compliance-obligations?id=...  — update status/filed_ref/notes
 */
export const config = { runtime: 'nodejs', maxDuration: 30 }

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } })

function env(k: string): string {
  const proc = (globalThis as Record<string, unknown>)['process'] as
    { env?: Record<string, string | undefined> } | undefined
  return proc?.env?.[k] ?? ''
}

async function pg(url: string, key: string, path: string, method = 'GET', body?: unknown, schema = 'pramaana') {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema,
      Prefer: method === 'GET' ? 'count=exact' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`DB ${method} ${path}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

// Returns the user's role for this company, or null if not a member.
// Queries registry schema — company_users lives there, not pramaana.
async function memberRole(supabaseUrl: string, serviceKey: string, userId: string, companyId: string): Promise<string | null> {
  const rows = await pg(supabaseUrl, serviceKey,
    `company_users?user_id=eq.${userId}&company_id=eq.${companyId}&select=role`,
    'GET', undefined, 'registry').catch(() => [] as unknown[])
  if (!Array.isArray(rows) || !rows.length) return null
  return (rows[0] as { role: string }).role
}
async function authUserId(req: Request, supabaseUrl: string, serviceKey: string): Promise<string | null> {
  const header = req.headers.get('Authorization') ?? ''
  if (!header.startsWith('Bearer ')) return null
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: header },
  })
  if (!res.ok) return null
  return ((await res.json()) as { id: string }).id
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url        = new URL(req.url)
    const companyId  = url.searchParams.get('company_id')
    const id         = url.searchParams.get('id')
    const status     = url.searchParams.get('status')          // 'upcoming,overdue' etc.
    const obligation = url.searchParams.get('obligation')
    const limit      = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200)

    const supabaseUrl = env('VITE_SUPABASE_URL')
    const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

    const userId = await authUserId(req, supabaseUrl, serviceKey)
    if (!userId) return json({ error: 'Unauthorized' }, 401)

    if (id) {
      const rows = await pg(supabaseUrl, serviceKey,
        `compliance_obligations?id=eq.${id}&select=*`)
      if (!Array.isArray(rows) || !rows.length) return json({ error: 'Not found' }, 404)
      const row = rows[0] as { company_id: string }
      if (!await memberRole(supabaseUrl, serviceKey, userId, row.company_id)) return json({ error: 'Access denied' }, 403)
      return json(row)
    }

    if (!companyId) return json({ error: 'company_id required' }, 400)
    if (!await memberRole(supabaseUrl, serviceKey, userId, companyId)) return json({ error: 'Access denied' }, 403)

    let path = `compliance_obligations?company_id=eq.${companyId}&order=due_date.asc&limit=${limit}`
    if (status) {
      const statuses = status.split(',').map(s => s.trim()).join(',')
      path += `&status=in.(${statuses})`
    }
    if (obligation) path += `&obligation=eq.${encodeURIComponent(obligation)}`

    const rows = await pg(supabaseUrl, serviceKey, path)
    return json(rows)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('compliance-obligations GET crash:', msg)
    return json({ error: msg }, 500)
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const supabaseUrl = env('VITE_SUPABASE_URL')
    const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

    const userId = await authUserId(req, supabaseUrl, serviceKey)
    if (!userId) return json({ error: 'Unauthorized' }, 401)

    const body = await req.json() as Record<string, unknown>
    const companyId = body.company_id as string
    if (!companyId) return json({ error: 'company_id required' }, 400)

    if (!await memberRole(supabaseUrl, serviceKey, userId, companyId)) return json({ error: 'Access denied' }, 403)

    const rows = await pg(supabaseUrl, serviceKey, 'compliance_obligations', 'POST', body)
    return json(Array.isArray(rows) ? rows[0] : rows, 201)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return json({ error: msg }, 500)
  }
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    const supabaseUrl = env('VITE_SUPABASE_URL')
    const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

    const userId = await authUserId(req, supabaseUrl, serviceKey)
    if (!userId) return json({ error: 'Unauthorized' }, 401)

    const url = new URL(req.url)
    const id  = url.searchParams.get('id')
    if (!id) return json({ error: 'id required' }, 400)

    const existing = await pg(supabaseUrl, serviceKey,
      `compliance_obligations?id=eq.${id}&select=company_id`)
    if (!Array.isArray(existing) || !existing.length) return json({ error: 'Not found' }, 404)
    const companyId = (existing[0] as { company_id: string }).company_id
    if (!await memberRole(supabaseUrl, serviceKey, userId, companyId)) return json({ error: 'Access denied' }, 403)

    const body = await req.json() as Record<string, unknown>
    // Immutable fields
    delete body.id
    delete body.company_id
    delete body.created_at
    body.updated_at = new Date().toISOString()

    const rows = await pg(supabaseUrl, serviceKey,
      `compliance_obligations?id=eq.${id}`, 'PATCH', body)
    return json(Array.isArray(rows) ? rows[0] : rows)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return json({ error: msg }, 500)
  }
}
