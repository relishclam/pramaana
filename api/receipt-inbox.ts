/**
 * GET /api/receipt-inbox
 * Lists receipt_inbox items visible to the caller (per RLS semantics),
 * newest first, with suggested voucher details joined.
 */

export const config = { maxDuration: 15 }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function env(k: string): string { return ((globalThis as any)?.process?.env?.[k] as string) ?? '' }
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = env('VITE_SUPABASE_URL')
  const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401)
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: authHeader },
  })
  if (!userRes.ok) return json({ error: 'Unauthorized' }, 401)
  const { id: userId } = await userRes.json() as { id: string }

  const h = {
    apikey:           serviceKey,
    Authorization:    `Bearer ${serviceKey}`,
    'Content-Type':   'application/json',
    'Accept-Profile': 'pramaana',
  }

  // Mirror the RLS policy: shared_by OR company member OR unassigned + admin
  const companiesRes = await fetch(
    `${supabaseUrl}/rest/v1/company_users?user_id=eq.${userId}&select=company_id,role`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Accept-Profile': 'registry' } },
  )
  const companies = companiesRes.ok ? await companiesRes.json() as { company_id: string; role: string }[] : []
  const isAdmin = companies.some(c => ['accounts','admin','super_admin'].includes(c.role))
  const companyIds = companies.map(c => c.company_id)

  let filter = `shared_by=eq.${userId}`
  if (companyIds.length) filter += `,company_id=in.(${companyIds.join(',')})`
  if (isAdmin) filter += ',company_id=is.null'

  const inboxRes = await fetch(
    `${supabaseUrl}/rest/v1/receipt_inbox?or=(${filter})&order=created_at.desc&limit=100` +
    `&select=id,status,file_path,mime_type,company_id,ocr_utr,ocr_amount,ocr_date,` +
    `ocr_payee_hint,suggestion_confidence,auto_matched,amount_delta,created_at,` +
    `suggested_voucher_id,attached_voucher_id,confirmed_at`,
    { headers: h },
  )
  if (!inboxRes.ok) return json({ error: 'Failed to load inbox' }, 500)
  const items = await inboxRes.json() as Record<string, unknown>[]

  // Enrich with voucher summaries for suggested/attached items
  const voucherIds = [...new Set(
    items.flatMap(i => [i.suggested_voucher_id, i.attached_voucher_id]).filter(Boolean) as string[]
  )]

  type VoucherSummary = { id: string; voucher_number: string; amount: number; company_id: string; entity_id: string | null }
  const voucherMap = new Map<string, VoucherSummary>()
  if (voucherIds.length) {
    const vRes = await fetch(
      `${supabaseUrl}/rest/v1/vouchers?id=in.(${voucherIds.join(',')})&select=id,voucher_number,amount,company_id,entity_id`,
      { headers: h },
    )
    if (vRes.ok) {
      const vs = await vRes.json() as VoucherSummary[]
      vs.forEach(v => voucherMap.set(v.id, v))
    }
  }

  // Signed URLs for thumbnails (images only)
  const enriched = await Promise.all(items.map(async (item) => {
    const path = item.file_path as string
    let thumb_url: string | null = null

    if ((item.mime_type as string)?.startsWith('image/')) {
      try {
        const signRes = await fetch(
          `${supabaseUrl}/storage/v1/object/sign/receipts/${path}`,
          {
            method: 'POST',
            headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ expiresIn: 3600 }),
          },
        )
        if (signRes.ok) {
          const signData = await signRes.json() as { signedURL?: string }
          thumb_url = signData.signedURL ? `${supabaseUrl}/storage/v1${signData.signedURL}` : null
        }
      } catch { /* skip */ }
    }

    const svId = item.suggested_voucher_id as string | null
    const avId = item.attached_voucher_id as string | null
    return {
      ...item,
      thumb_url,
      suggested_voucher:  svId ? voucherMap.get(svId) ?? null : null,
      attached_voucher:   avId ? voucherMap.get(avId) ?? null : null,
    }
  }))

  return json({ items: enriched })
}
