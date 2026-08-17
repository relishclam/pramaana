/**
 * GET  /api/compliance-profile?company_id=...
 * POST /api/compliance-profile  — upsert (super_admin only)
 */
export const config = { runtime: 'nodejs', maxDuration: 15 }

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } })

function env(k: string): string {
  const proc = (globalThis as Record<string, unknown>)['process'] as
    { env?: Record<string, string | undefined> } | undefined
  return proc?.env?.[k] ?? ''
}

async function pg(url: string, key: string, path: string, method = 'GET', body?: unknown, schema = 'registry', prefer = 'return=representation') {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema,
      Prefer: prefer,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`DB ${method}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function authUser(req: Request, url: string, key: string): Promise<{ id: string; is_super_admin?: boolean } | null> {
  const header = req.headers.get('Authorization') ?? ''
  if (!header.startsWith('Bearer ')) return null
  const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: header } })
  if (!res.ok) return null
  const u = await res.json() as { id: string }
  // registry.profiles is the canonical profile table; explicit schema arg guards against default drift
  const profile = await pg(url, key, `profiles?id=eq.${u.id}&select=is_super_admin`,
    'GET', undefined, 'registry').catch((e: unknown) => {
    console.error('[compliance-profile] registry.profiles lookup failed:', e)
    return [] as unknown[]
  })
  const isSA = Array.isArray(profile) && profile.length > 0
    && (profile[0] as { is_super_admin: boolean | null }).is_super_admin === true
  return { id: u.id, is_super_admin: isSA }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const supabaseUrl = env('VITE_SUPABASE_URL')
    const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

    const url       = new URL(req.url)
    const companyId = url.searchParams.get('company_id')
    if (!companyId) return json({ error: 'company_id required' }, 400)

    const user = await authUser(req, supabaseUrl, serviceKey)
    if (!user) return json({ error: 'Unauthorized' }, 401)

    // Member or super_admin can read their company profile
    const membership = await pg(supabaseUrl, serviceKey,
      `company_users?user_id=eq.${user.id}&company_id=eq.${companyId}&select=role`).catch(() => [] as unknown[])
    if (!user.is_super_admin && (!Array.isArray(membership) || !membership.length)) {
      return json({ error: 'Access denied' }, 403)
    }

    const rows = await pg(supabaseUrl, serviceKey, `company_statutory?company_id=eq.${companyId}&select=*`)
    return json(Array.isArray(rows) && rows.length ? rows[0] : null)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return json({ error: msg }, 500)
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const supabaseUrl = env('VITE_SUPABASE_URL')
    const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

    const user = await authUser(req, supabaseUrl, serviceKey)
    if (!user) return json({ error: 'Unauthorized' }, 401)
    if (!user.is_super_admin) return json({ error: 'Super admin required' }, 403)

    const body = await req.json() as Record<string, unknown>
    if (!body.company_id) return json({ error: 'company_id required' }, 400)

    delete body.created_at
    body.updated_at = new Date().toISOString()

    const rows = await pg(supabaseUrl, serviceKey,
      `company_statutory?on_conflict=company_id`, 'POST', body, 'registry',
      'resolution=merge-duplicates,return=representation')
    return json(Array.isArray(rows) ? rows[0] : rows, 201)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return json({ error: msg }, 500)
  }
}
