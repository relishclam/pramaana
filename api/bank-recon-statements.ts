/**
 * GET  /api/bank-recon-statements?company_id=...&bank_account_id=...
 * GET  /api/bank-recon-statements?id=...               (single statement with transactions)
 * DELETE /api/bank-recon-statements?id=...&company_id=...
 */
export const config = { runtime: 'nodejs', maxDuration: 30 }

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

export async function GET(req: Request): Promise<Response> {
  try { return await handleRequest(req) } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('bank-recon-statements crash:', msg)
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try { return await handleRequest(req) } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('bank-recon-statements crash:', msg)
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

  const url   = new URL(req.url)
  const id    = url.searchParams.get('id')
  const companyId = url.searchParams.get('company_id')
  const bankAccountId = url.searchParams.get('bank_account_id')

  if (req.method === 'DELETE') {
    if (!id || !companyId) return json({ error: 'id and company_id required' }, 400)
    // PostgREST returns 204 No Content for DELETE — don't try to parse JSON body
    const res = await fetch(`${supabaseUrl}/rest/v1/recon_statements?id=eq.${id}&company_id=eq.${companyId}`, {
      method: 'DELETE',
      headers: {
        apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
        'Accept-Profile': 'pramaana', 'Content-Profile': 'pramaana',
      },
    })
    if (!res.ok) {
      const errText = await res.text()
      console.error('recon_statements DELETE failed:', errText)
      return json({ error: `Delete failed: ${errText}` }, 500)
    }
    return json({ status: 'deleted', id })
  }

  if (req.method === 'GET') {
    if (id) {
      // Single statement + transactions
      const { data: stmts } = await dbFetch(supabaseUrl, serviceKey, 'GET',
        `recon_statements?id=eq.${id}&select=*,recon_bank_accounts(bank_code,bank_name,account_number)`)
      const { data: txns } = await dbFetch(supabaseUrl, serviceKey, 'GET',
        `recon_transactions?statement_id=eq.${id}&order=row_number.asc&select=*,recon_matches(id,match_method,match_confidence,match_reason,is_confirmed,voucher_id)`)
      return json({ statement: (stmts as unknown[])[0] ?? null, transactions: txns ?? [] })
    }

    if (companyId) {
      let path = `recon_statements?company_id=eq.${companyId}&order=created_at.desc&select=*,recon_bank_accounts(bank_code,bank_name,account_number)`
      if (bankAccountId) path += `&bank_account_id=eq.${bankAccountId}`
      const { data } = await dbFetch(supabaseUrl, serviceKey, 'GET', path)
      return json(data ?? [])
    }

    return json({ error: 'id or company_id required' }, 400)
  }

  return json({ error: 'Method not allowed' }, 405)
}
