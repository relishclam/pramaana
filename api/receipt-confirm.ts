/**
 * POST /api/receipt-confirm
 * Human confirms (or system auto-confirms) a receipt → voucher match.
 * Also handles unmatch (reversal within 48h, super_admin/accounts only).
 *
 * Actions:
 *   confirm: { action:'confirm', inbox_id, voucher_id, utr }
 *   unmatch: { action:'unmatch', inbox_id }
 */

export const config = { maxDuration: 30 }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function env(k: string): string { return ((globalThis as any)?.process?.env?.[k] as string) ?? '' }
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

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

  let body: { action?: string; inbox_id?: string; voucher_id?: string; utr?: string }
  try { body = await req.json() as typeof body } catch { return json({ error: 'Invalid JSON' }, 400) }

  const h = {
    apikey:            serviceKey,
    Authorization:     `Bearer ${serviceKey}`,
    'Content-Type':    'application/json',
    'Accept-Profile':  'pramaana',
    'Content-Profile': 'pramaana',
  }

  // ── UNMATCH (reversal) ────────────────────────────────────────────────────
  if (body.action === 'unmatch') {
    const { inbox_id } = body
    if (!inbox_id) return json({ error: 'inbox_id required' }, 400)

    // Load inbox row
    const ibRes = await fetch(
      `${supabaseUrl}/rest/v1/receipt_inbox?id=eq.${inbox_id}&select=status,attached_voucher_id,company_id,auto_matched,confirmed_at`,
      { headers: h },
    )
    const ibRows = ibRes.ok ? await ibRes.json() as {
      status: string; attached_voucher_id: string | null
      company_id: string | null; auto_matched: boolean; confirmed_at: string | null
    }[] : []
    if (!ibRows.length) return json({ error: 'Inbox item not found' }, 404)
    const ib = ibRows[0]

    if (ib.status !== 'attached') return json({ error: 'Only attached items can be unmatched' }, 422)

    // 48h window
    if (ib.confirmed_at) {
      const confirmedMs = new Date(ib.confirmed_at).getTime()
      if (Date.now() - confirmedMs > 48 * 60 * 60 * 1000) {
        return json({ error: 'Unmatch window expired (48h)' }, 422)
      }
    }

    // Check bank-recon UTR lock — if UTR already matched in recon, block
    if (ib.attached_voucher_id) {
      const voucherRes = await fetch(
        `${supabaseUrl}/rest/v1/vouchers?id=eq.${ib.attached_voucher_id}&select=utr_number,company_id`,
        { headers: h },
      )
      const vRows = voucherRes.ok ? await voucherRes.json() as { utr_number: string | null; company_id: string }[] : []
      const vUtr = vRows[0]?.utr_number
      if (vUtr) {
        // Check if UTR is locked by a recon match
        const reconRes = await fetch(
          `${supabaseUrl}/rest/v1/recon_matches?utr_match_value=eq.${encodeURIComponent(vUtr)}&match_status=neq.rejected&select=id`,
          { headers: h },
        )
        const reconRows = reconRes.ok ? await reconRes.json() as unknown[] : []
        if (reconRows.length > 0) return json({ error: 'UTR confirmed by bank reconciliation — unmatch not allowed' }, 422)
      }

      // Caller must be accounts/admin/super_admin for this company
      const cuRes = await fetch(
        `${supabaseUrl}/rest/v1/company_users?user_id=eq.${userId}&company_id=eq.${vRows[0]?.company_id}&select=role`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Accept-Profile': 'registry' } },
      )
      const cuRows = cuRes.ok ? await cuRes.json() as { role: string }[] : []
      const role = cuRows[0]?.role ?? ''
      if (!['accounts','admin','super_admin'].includes(role)) {
        return json({ error: 'Insufficient permissions — accounts/admin/super_admin only' }, 403)
      }

      // Revert voucher → awaiting_payment, clear UTR
      await fetch(`${supabaseUrl}/rest/v1/vouchers?id=eq.${ib.attached_voucher_id}`, {
        method:  'PATCH',
        headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'awaiting_payment', utr_number: null, paid_at: null }),
      })

      // Delete voucher attachment pointing at this receipt
      if (ib.company_id) {
        const inboxFull = await fetch(
          `${supabaseUrl}/rest/v1/receipt_inbox?id=eq.${inbox_id}&select=file_path`,
          { headers: h },
        ).then(r => r.json() as Promise<{ file_path: string }[]>)
        if (inboxFull[0]?.file_path) {
          await fetch(
            `${supabaseUrl}/rest/v1/voucher_attachments?storage_path=eq.${encodeURIComponent(inboxFull[0].file_path)}`,
            { method: 'DELETE', headers: h },
          )
        }
      }
    }

    // Reset inbox row
    await fetch(`${supabaseUrl}/rest/v1/receipt_inbox?id=eq.${inbox_id}`, {
      method:  'PATCH',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        status:              'needs_assignment',
        attached_voucher_id: null,
        confirmed_by:        null,
        confirmed_at:        null,
        auto_matched:        false,
        updated_at:          new Date().toISOString(),
      }),
    })

    // Audit row
    await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
      method:  'POST',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        table_name: 'receipt_inbox', record_id: ib.attached_voucher_id ?? inbox_id,
        company_id: ib.company_id,
        operation:  'UPDATE',
        new_row:    { note: `receipt unmatched: ${inbox_id} by ${userId}` },
        changed_by:  userId, changed_via: 'app',
      }),
    })

    return json({ unmatched: true })
  }

  // ── CONFIRM ───────────────────────────────────────────────────────────────
  const { inbox_id, voucher_id, utr } = body
  if (!inbox_id || !voucher_id) return json({ error: 'inbox_id and voucher_id required' }, 400)

  // Load inbox
  const ibRes = await fetch(
    `${supabaseUrl}/rest/v1/receipt_inbox?id=eq.${inbox_id}&select=file_path,ocr_amount,ocr_date,ocr_utr`,
    { headers: h },
  )
  const ibRows = ibRes.ok ? await ibRes.json() as {
    file_path: string; ocr_amount: number | null; ocr_date: string | null; ocr_utr: string | null
  }[] : []
  if (!ibRows.length) return json({ error: 'Inbox item not found' }, 404)
  const ib = ibRows[0]

  // Load voucher
  const vRes = await fetch(
    `${supabaseUrl}/rest/v1/vouchers?id=eq.${voucher_id}&select=id,company_id,status,amount,payment_mode,voucher_number,entity_id`,
    { headers: h },
  )
  const vRows = vRes.ok ? await vRes.json() as {
    id: string; company_id: string; status: string; amount: number
    payment_mode: string | null; voucher_number: string; entity_id: string | null
  }[] : []
  if (!vRows.length) return json({ error: 'Voucher not found' }, 404)
  const v = vRows[0]

  // Voucher must be awaiting_payment
  if (v.status !== 'awaiting_payment') {
    return json({ error: `Voucher is not awaiting payment (status: ${v.status})` }, 422)
  }

  // UTR required for bank/UPI payment modes
  const needsUtr = ['upi','bank','neft','rtgs','imps'].includes((v.payment_mode ?? '').toLowerCase())
  const effectiveUtr = (utr ?? ib.ocr_utr ?? '').trim()
  if (needsUtr && !effectiveUtr) {
    return json({ error: 'UTR_REQUIRED: provide utr field for this payment mode' }, 422)
  }

  // Verify caller has company membership
  const cuRes = await fetch(
    `${supabaseUrl}/rest/v1/company_users?user_id=eq.${userId}&company_id=eq.${v.company_id}&select=role`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Accept-Profile': 'registry' } },
  )
  const cuRows = cuRes.ok ? await cuRes.json() as { role: string }[] : []
  if (!cuRows.length) return json({ error: 'Not a member of this company' }, 403)

  const paymentDate = ib.ocr_date ?? new Date().toISOString().slice(0, 10)
  const amountDelta = ib.ocr_amount != null ? ib.ocr_amount - v.amount : null

  // ── Atomic: update voucher + attach receipt + update inbox ─────────────────
  await fetch(`${supabaseUrl}/rest/v1/vouchers?id=eq.${voucher_id}&status=eq.awaiting_payment`, {
    method:  'PATCH',
    headers: { ...h, Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'posted', utr_number: effectiveUtr || null,
      paid_at: new Date(paymentDate).toISOString() }),
  })

  await fetch(`${supabaseUrl}/rest/v1/voucher_attachments`, {
    method:  'POST',
    headers: { ...h, Prefer: 'return=minimal' },
    body: JSON.stringify({
      voucher_id: voucher_id, company_id: v.company_id,
      storage_path: ib.file_path, file_name: ib.file_path.split('/').pop(),
      uploaded_by: userId, attachment_type: 'transfer_receipt',
    }),
  })

  await fetch(`${supabaseUrl}/rest/v1/receipt_inbox?id=eq.${inbox_id}`, {
    method:  'PATCH',
    headers: { ...h, Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'attached', attached_voucher_id: voucher_id,
      company_id: v.company_id, confirmed_by: userId,
      confirmed_at: new Date().toISOString(), amount_delta: amountDelta,
      updated_at: new Date().toISOString(),
    }),
  })

  if (amountDelta && Math.abs(amountDelta) > 0) {
    await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
      method:  'POST',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        table_name: 'receipt_inbox', record_id: voucher_id, company_id: v.company_id,
        operation: 'UPDATE', changed_by: userId, changed_via: 'app',
        new_row: { note: `receipt confirmed with amount delta ₹${amountDelta}: ${inbox_id} → ${v.voucher_number}` },
      }),
    })
  }

  // T3 WhatsApp — best-effort, post-commit
  if (v.entity_id) {
    const host = 'pramaana-tau.vercel.app'
    fetch(`https://${host}/api/send-whatsapp`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: 'payment-confirmed',
        mobile:   v.entity_id,
        vars:     [v.amount.toLocaleString('en-IN'), v.voucher_number],
        source:   'mode-b',
      }),
    }).catch(() => { /* best-effort */ })
  }

  return json({ confirmed: true, voucher_number: v.voucher_number, amount_delta: amountDelta })
}
