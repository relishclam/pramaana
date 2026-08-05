/**
 * POST /api/bank-recon-confirm
 * Confirm or reject a suggested match.
 * Body: { match_id, action: 'confirm'|'reject', correct_voucher_id? }
 */
export const config = { runtime: 'edge' }

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } })

function env(k: string): string {
  const proc = (globalThis as Record<string, unknown>)['process'] as
    { env?: Record<string, string | undefined> } | undefined
  return proc?.env?.[k] ?? ''
}

async function dbFetch(url: string, key: string, method: string, path: string, body?: unknown, schema = 'pramaana'): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema,
      Prefer: method === 'GET' ? 'return=representation' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { ok: res.ok, data: res.ok ? await res.json() : null }
}

export async function POST(req: Request): Promise<Response> {
  try { return await handleRequest(req) } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('bank-recon-confirm crash:', msg)
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

  let body: { match_id?: string; action?: string; correct_voucher_id?: string }
  try { body = await req.json() as { match_id?: string; action?: string; correct_voucher_id?: string } } catch { return json({ error: 'Invalid JSON' }, 400) }
  if (!body.match_id || !body.action) return json({ error: 'match_id and action required' }, 400)
  if (!['confirm', 'reject'].includes(body.action)) return json({ error: 'action must be confirm or reject' }, 400)

  // Load match record
  const { ok: getOk, data: matchRows } = await dbFetch(supabaseUrl, serviceKey, 'GET',
    `recon_matches?id=eq.${body.match_id}&select=id,bank_txn_id,company_id`)
  if (!getOk || !(matchRows as unknown[]).length) return json({ error: 'Match not found' }, 404)
  const match = (matchRows as { id: string; bank_txn_id: string; company_id: string }[])[0]

  if (body.action === 'confirm') {
    await dbFetch(supabaseUrl, serviceKey, 'PATCH',
      `recon_matches?id=eq.${body.match_id}`,
      { is_confirmed: true, matched_by: userId, matched_at: new Date().toISOString() })
    await dbFetch(supabaseUrl, serviceKey, 'PATCH',
      `recon_transactions?id=eq.${match.bank_txn_id}`,
      { match_status: 'manual_matched' })
    return json({ status: 'confirmed' })
  }

  // Reject: delete the match, reset transaction
  await dbFetch(supabaseUrl, serviceKey, 'DELETE', `recon_matches?id=eq.${body.match_id}`)
  await dbFetch(supabaseUrl, serviceKey, 'PATCH',
    `recon_transactions?id=eq.${match.bank_txn_id}`,
    { match_status: 'unmatched' })

  // If a correct voucher is provided, create a new confirmed match
  if (body.correct_voucher_id) {
    await dbFetch(supabaseUrl, serviceKey, 'POST', 'recon_matches', {
      company_id:       match.company_id,
      bank_txn_id:      match.bank_txn_id,
      voucher_id:       body.correct_voucher_id,
      match_method:     'manual',
      match_confidence: 100,
      match_reason:     'Manually assigned',
      matched_by:       userId,
      is_confirmed:     true,
    })
    await dbFetch(supabaseUrl, serviceKey, 'PATCH',
      `recon_transactions?id=eq.${match.bank_txn_id}`,
      { match_status: 'manual_matched' })
  }

  return json({ status: 'rejected' })
}
