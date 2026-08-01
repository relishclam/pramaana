/**
 * Vercel Edge Function — trigger bank matching RPC.
 * POST /api/bank-match
 *
 * Body: { statement_id }
 * Calls pramaana.run_bank_match(statement_id) via service-role RPC.
 * Returns pass counts and timing from the RPC result.
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

  let body: { statement_id?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { statement_id } = body
  if (!statement_id) return json({ error: 'statement_id required' }, 400)

  const supabaseUrl = env('VITE_SUPABASE_URL')
  const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

  const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/run_bank_match`, {
    method: 'POST',
    headers: {
      apikey:            serviceKey,
      Authorization:     `Bearer ${serviceKey}`,
      'Content-Profile': 'pramaana',
      'Content-Type':    'application/json',
    },
    body: JSON.stringify({ p_statement_id: statement_id }),
  })

  if (!rpcRes.ok) {
    const err = await rpcRes.text()
    return json({ error: `Match RPC failed: ${err}` }, 500)
  }

  const result = await rpcRes.json()
  return json(result)
}
