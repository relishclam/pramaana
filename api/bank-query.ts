/**
 * Vercel Edge Function — bank recon query management.
 * POST /api/bank-query
 *
 * Actions:
 *   { action: 'create', company_id, subject, line_ids[], message }
 *     → creates audit_query + items + first message, fires WhatsApp notification
 *
 *   { action: 'respond', query_id, body, attachment_path? }
 *     → adds a message to the thread
 *
 *   { action: 'close', query_id, resolution_voucher_id? }
 *     → sets status=closed (or rectified if voucher supplied)
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

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { action } = body
  if (!action) return json({ error: 'action required' }, 400)

  const supabaseUrl = env('VITE_SUPABASE_URL')
  const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 403)

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: authHeader },
  })
  if (!userRes.ok) return json({ error: 'Unauthorized' }, 403)
  const { id: user_id } = await userRes.json() as { id: string }

  const pramaanaHeaders = {
    apikey:            serviceKey,
    Authorization:     `Bearer ${serviceKey}`,
    'Accept-Profile':  'pramaana',
    'Content-Profile': 'pramaana',
    'Content-Type':    'application/json',
  }

  if (action === 'create') {
    const { company_id, subject, line_ids, message } = body as {
      company_id: string; subject: string; line_ids: string[]; message: string
    }
    if (!company_id || !subject || !line_ids?.length || !message) {
      return json({ error: 'create requires: company_id, subject, line_ids[], message' }, 400)
    }

    // Get next QRY sequence number
    const seqRes = await fetch(
      `${supabaseUrl}/rest/v1/sequence_counters?company_id=eq.${company_id}&prefix=eq.QRY&select=last_number,year`,
      {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Accept-Profile': 'registry' },
      },
    )
    const seqRows = seqRes.ok ? await seqRes.json() as { last_number: number; year: string }[] : []
    const nextNum  = (seqRows[0]?.last_number ?? 0) + 1
    const fy       = seqRows[0]?.year ?? '2627'

    // Get company code
    const coRes = await fetch(
      `${supabaseUrl}/rest/v1/companies?id=eq.${company_id}&select=code`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Accept-Profile': 'registry' } },
    )
    const coRows = coRes.ok ? await coRes.json() as { code: string }[] : []
    const coCode = coRows[0]?.code ?? 'XX'
    const query_no = `${coCode}/QRY/${fy}/${String(nextNum).padStart(4, '0')}`

    // Insert audit_query
    const qRes = await fetch(`${supabaseUrl}/rest/v1/audit_queries`, {
      method: 'POST',
      headers: { ...pramaanaHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({ company_id, query_no, raised_by: user_id, context_type: 'bank_line', subject }),
    })
    if (!qRes.ok) return json({ error: `Failed to create query: ${await qRes.text()}` }, 500)
    const [query] = await qRes.json() as { id: string }[]

    // Increment sequence
    await fetch(
      `${supabaseUrl}/rest/v1/sequence_counters?company_id=eq.${company_id}&prefix=eq.QRY`,
      {
        method: 'PATCH',
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Accept-Profile': 'registry', 'Content-Profile': 'registry', 'Content-Type': 'application/json' },
        body: JSON.stringify({ last_number: nextNum }),
      },
    )

    // Insert query items for each line
    const items = line_ids.map((line_id: string) => ({ query_id: query.id, line_id }))
    await fetch(`${supabaseUrl}/rest/v1/audit_query_items`, {
      method: 'POST',
      headers: { ...pramaanaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify(items),
    })

    // Update line statuses to 'queried'
    for (const line_id of line_ids) {
      await fetch(`${supabaseUrl}/rest/v1/bank_statement_lines?id=eq.${line_id}`, {
        method: 'PATCH',
        headers: pramaanaHeaders,
        body: JSON.stringify({ match_status: 'queried' }),
      })
    }

    // Insert first message
    await fetch(`${supabaseUrl}/rest/v1/audit_query_messages`, {
      method: 'POST',
      headers: { ...pramaanaHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ query_id: query.id, author_id: user_id, body: message }),
    })

    // Fire WhatsApp notification (best-effort — don't fail query creation if WA fails)
    try {
      const mobile = env('ACCOUNTS_WHATSAPP_MOBILE')
      if (mobile) {
        await fetch(`${supabaseUrl.replace('/rest/v1', '')}/functions/v1/..`, {
          // Use the existing send-whatsapp edge function via relative call
          method: 'POST',
        })
        // Simplified: post to our own /api/send-whatsapp
        const waBody = JSON.stringify({
          template: 'bank-recon-query',
          mobile,
          vars: [query_no, subject, String(line_ids.length)],
        })
        await fetch(`https://${req.headers.get('host')}/api/send-whatsapp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: waBody,
        })
      }
    } catch { /* WA failure is non-fatal */ }

    return json({ query_id: query.id, query_no })
  }

  if (action === 'respond') {
    const { query_id, body: msgBody, attachment_path } = body as {
      query_id: string; body: string; attachment_path?: string
    }
    if (!query_id || !msgBody) return json({ error: 'respond requires: query_id, body' }, 400)

    const mRes = await fetch(`${supabaseUrl}/rest/v1/audit_query_messages`, {
      method: 'POST',
      headers: { ...pramaanaHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({ query_id, author_id: user_id, body: msgBody, attachment_path: attachment_path ?? null }),
    })
    if (!mRes.ok) return json({ error: `Failed to add message: ${await mRes.text()}` }, 500)
    const [msg] = await mRes.json() as { id: string }[]

    // Update query status to 'responded' if currently 'open'
    await fetch(`${supabaseUrl}/rest/v1/audit_queries?id=eq.${query_id}&status=eq.open`, {
      method: 'PATCH',
      headers: pramaanaHeaders,
      body: JSON.stringify({ status: 'responded' }),
    })

    return json({ message_id: msg.id })
  }

  if (action === 'close') {
    const { query_id, resolution_voucher_id } = body as {
      query_id: string; resolution_voucher_id?: string
    }
    if (!query_id) return json({ error: 'close requires: query_id' }, 400)

    const newStatus = resolution_voucher_id ? 'rectified' : 'closed'
    await fetch(`${supabaseUrl}/rest/v1/audit_queries?id=eq.${query_id}`, {
      method: 'PATCH',
      headers: pramaanaHeaders,
      body: JSON.stringify({ status: newStatus, closed_at: new Date().toISOString() }),
    })

    // Flip queried lines attached to this query → resolved
    const itemsRes = await fetch(
      `${supabaseUrl}/rest/v1/audit_query_items?query_id=eq.${query_id}&line_id=not.is.null&select=line_id`,
      { headers: pramaanaHeaders },
    )
    if (itemsRes.ok) {
      const items = await itemsRes.json() as { line_id: string }[]
      for (const item of items) {
        await fetch(`${supabaseUrl}/rest/v1/bank_statement_lines?id=eq.${item.line_id}&match_status=eq.queried`, {
          method: 'PATCH',
          headers: pramaanaHeaders,
          body: JSON.stringify({ match_status: 'resolved' }),
        })
      }
    }

    return json({ status: newStatus })
  }

  return json({ error: `Unknown action: ${action}` }, 400)
}
