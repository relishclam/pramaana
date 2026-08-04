/**
 * GET  /api/bank-recon-accounts?company_id=...         list bank accounts
 * POST /api/bank-recon-accounts                         create/link bank account
 * PATCH /api/bank-recon-accounts?id=...                update (link ledger, etc.)
 */
export const config = { runtime: 'edge' }

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } })

function env(k: string): string {
  return ((globalThis as Record<string, unknown>)?.['process']?.['env']?.[k] as string) ?? ''
}

async function dbFetch(url: string, key: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept-Profile': 'pramaana', 'Content-Profile': 'pramaana',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { ok: res.ok, data: res.ok ? await res.json() : await res.text() }
}

export default async function handler(req: Request): Promise<Response> {
  const supabaseUrl = env('VITE_SUPABASE_URL')
  const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 403)
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: authHeader },
  })
  if (!userRes.ok) return json({ error: 'Unauthorized' }, 403)

  const params = new URL(req.url).searchParams
  const id = params.get('id')
  const companyId = params.get('company_id')

  if (req.method === 'GET') {
    if (!companyId) return json({ error: 'company_id required' }, 400)
    const { data } = await dbFetch(supabaseUrl, serviceKey, 'GET',
      `recon_bank_accounts?company_id=eq.${companyId}&is_active=eq.true&order=bank_name.asc&select=*,ledgers(name)`)
    return json(data ?? [])
  }

  if (req.method === 'PATCH') {
    if (!id) return json({ error: 'id required' }, 400)
    let body: Record<string, unknown>
    try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
    const { data } = await dbFetch(supabaseUrl, serviceKey, 'PATCH',
      `recon_bank_accounts?id=eq.${id}`,
      { ...body, updated_at: new Date().toISOString() })
    return json(data)
  }

  if (req.method === 'POST') {
    let body: Record<string, unknown>
    try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
    const { data } = await dbFetch(supabaseUrl, serviceKey, 'POST', 'recon_bank_accounts', body)
    return json(data)
  }

  return json({ error: 'Method not allowed' }, 405)
}
