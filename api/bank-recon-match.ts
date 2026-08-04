/**
 * POST /api/bank-recon-match
 * Re-run match engine on an existing statement (after new vouchers posted).
 * Body: { statement_id, company_id }
 */
export const config = { runtime: 'nodejs' }

import { runMatchEngine } from './lib/bank-recon/match-engine'

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } })

function env(k: string) { return process.env[k] ?? '' }

async function dbGet(url: string, key: string, path: string): Promise<unknown[]> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'pramaana' },
  })
  return res.ok ? res.json() as Promise<unknown[]> : []
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = env('VITE_SUPABASE_URL')
  const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 403)
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: authHeader },
  })
  if (!userRes.ok) return json({ error: 'Unauthorized' }, 403)

  let body: { statement_id?: string; company_id?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  if (!body.statement_id || !body.company_id) return json({ error: 'statement_id and company_id required' }, 400)

  const stmts = (await dbGet(supabaseUrl, serviceKey,
    `recon_statements?id=eq.${body.statement_id}&select=bank_account_id,recon_bank_accounts(ledger_id)`)) as { bank_account_id: string; recon_bank_accounts: { ledger_id: string | null } }[]

  const ledgerId = stmts[0]?.recon_bank_accounts?.ledger_id
  if (!ledgerId) return json({ error: 'Bank account not linked to a ledger' }, 400)

  const result = await runMatchEngine(body.statement_id, body.company_id, ledgerId, supabaseUrl, serviceKey)
  return json(result)
}
