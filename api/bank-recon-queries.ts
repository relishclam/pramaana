/**
 * GET   /api/bank-recon-queries?company_id=...&status=open
 * PATCH /api/bank-recon-queries?id=...   update status/resolution
 */
export const config = { runtime: 'edge' }

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } })

function env(k: string): string {
  const proc = (globalThis as Record<string, unknown>)['process'] as
    { env?: Record<string, string | undefined> } | undefined
  return proc?.env?.[k] ?? ''
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
  try { return await handleRequest(req) } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('bank-recon-queries crash:', msg)
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

async function handleRequest(req: Request): Promise<Response> {
  const supabaseUrl = env('VITE_SUPABASE_URL')
  const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 403)
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: authHeader },
  })
  if (!userRes.ok) return json({ error: 'Unauthorized' }, 403)
  const { id: userId } = await userRes.json() as { id: string }

  const params = new URL(req.url).searchParams

  if (req.method === 'GET') {
    const companyId  = params.get('company_id')
    const status     = params.get('status') ?? 'open'
    const bankAcctId = params.get('bank_account_id')
    if (!companyId) return json({ error: 'company_id required' }, 400)

    let path = `recon_queries?company_id=eq.${companyId}&status=eq.${status}` +
               `&order=created_at.desc&select=*,recon_transactions(txn_date,narration,debit,credit,bank_account_id)`
    if (bankAcctId) path += `&recon_transactions.bank_account_id=eq.${bankAcctId}`
    const { data } = await dbFetch(supabaseUrl, serviceKey, 'GET', path)
    return json(data ?? [])
  }

  if (req.method === 'PATCH') {
    const id = params.get('id')
    if (!id) return json({ error: 'id required' }, 400)
    let body: Record<string, unknown>
    try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
    const update: Record<string, unknown> = { ...body, updated_at: new Date().toISOString() }
    if (body.status === 'resolved' || body.status === 'written_off' || body.status === 'adjusted') {
      update.resolved_by = userId
      update.resolved_at = new Date().toISOString()
    }
    const { data } = await dbFetch(supabaseUrl, serviceKey, 'PATCH', `recon_queries?id=eq.${id}`, update)
    return json(data)
  }

  return json({ error: 'Method not allowed' }, 405)
}
