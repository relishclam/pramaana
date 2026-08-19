/**
 * POST /api/receipt-extract  (internal — called fire-and-forget by receipt-upload)
 * Runs GPT-4o vision OCR to extract UTR/amount/date from a payment receipt.
 * After extraction, immediately runs matchReceipt() to suggest or auto-confirm.
 *
 * Body: { id: string, fileBase64: string, fileType: string }
 */

export const config = { maxDuration: 60 }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function env(k: string): string { return ((globalThis as any)?.process?.env?.[k] as string) ?? '' }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

// ── Receipt OCR prompt ────────────────────────────────────────────────────────

const RECEIPT_PROMPT = `You are a payment receipt parser for Indian bank transactions (GPay, PhonePe, HDFC, SBI, ICICI, etc.).
Extract payment details from this receipt image. Return ONLY a single valid JSON object — no markdown, no explanation.

{
  "utr":              "transaction reference number — patterns: 12-digit numeric (UPI/IMPS ref), or 16-char alphanumeric starting with bank code e.g. HDFC0123456789AB (NEFT/RTGS UTR). Copy exactly character-by-character. Empty string if absent.",
  "amount":           numeric value of the payment amount (plain number, no ₹ or commas — Indian format: 1,00,000 = 100000),
  "date":             "payment date in YYYY-MM-DD format, empty if not found",
  "payee_hint":       "payee/beneficiary name as printed, empty if absent",
  "debit_account_hint": "sender VPA (e.g. 9446012324@okaxis) or last-4 of debit account, empty if absent"
}

Rules:
1. UTR is critical — read each character individually. 12-digit numeric = UPI/IMPS. 16-char alphanumeric with bank prefix = NEFT/RTGS.
2. Amount: remove all commas and ₹ symbols. 1,00,000 = 100000.
3. If UTR is ambiguous or unreadable, return empty string.
4. Return ONLY the JSON object, nothing else.`

// ── Tier 0 auto-match + Tier 1 suggest ────────────────────────────────────────

async function matchReceipt(
  inboxId:    string,
  userId:     string,
  ocrUtr:     string | null,
  ocrAmount:  number | null,
  supabaseUrl: string,
  serviceKey:  string,
): Promise<void> {
  const h = {
    apikey:            serviceKey,
    Authorization:     `Bearer ${serviceKey}`,
    'Content-Type':    'application/json',
    'Accept-Profile':  'pramaana',
    'Content-Profile': 'pramaana',
  }

  // Get all companies the user belongs to
  const cuRes = await fetch(
    `${supabaseUrl}/rest/v1/company_users?user_id=eq.${userId}&select=company_id`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Accept-Profile': 'registry' } },
  )
  const cuRows = cuRes.ok ? await cuRes.json() as { company_id: string }[] : []
  if (!cuRows.length) return

  const companyIds = cuRows.map(r => r.company_id)
  const companyFilter = `company_id=in.(${companyIds.join(',')})`

  // Candidate vouchers: awaiting_payment (= otp_verified_awaiting_evidence) within 14 days
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const candidateRes = await fetch(
    `${supabaseUrl}/rest/v1/vouchers?${companyFilter}&status=eq.awaiting_payment&voucher_date=gte.${since.slice(0,10)}&select=id,voucher_number,amount,company_id,entity_id,utr_number`,
    { headers: h },
  )
  const candidates = candidateRes.ok ? await candidateRes.json() as {
    id: string; voucher_number: string; amount: number
    company_id: string; entity_id: string | null; utr_number: string | null
  }[] : []

  if (!candidates.length) {
    await patchInbox(inboxId, { status: 'needs_assignment' }, supabaseUrl, serviceKey)
    return
  }

  // ── Score each candidate ───────────────────────────────────────────────────
  type Scored = { id: string; voucher_number: string; company_id: string
    entity_id: string | null; score: number; delta: number }

  const scored: Scored[] = candidates.map(v => {
    let score = 0
    const delta = ocrAmount != null ? Math.abs(ocrAmount - v.amount) : null

    if (ocrAmount != null && delta !== null) {
      if (delta === 0)     score += 60
      else if (delta <= 1) score += 50
    }
    if (ocrUtr && v.utr_number === ocrUtr) score += 40
    return { id: v.id, voucher_number: v.voucher_number, company_id: v.company_id,
      entity_id: v.entity_id, score, delta: delta ?? 9999 }
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score)

  if (!scored.length) {
    await patchInbox(inboxId, { status: 'needs_assignment' }, supabaseUrl, serviceKey)
    return
  }

  const best = scored[0]

  // ── Tier 0: AUTO-CONFIRM (all 5 conditions) ───────────────────────────────
  const validUtr = ocrUtr && /^\d{12}$/.test(ocrUtr) || /^[A-Z]{4}[A-Z0-9]{12}$/.test(ocrUtr ?? '')
  const exactAmount = best.delta === 0
  const exactlyOneCandidate = scored.filter(s => s.delta === 0).length === 1

  if (validUtr && exactAmount && exactlyOneCandidate && ocrAmount != null) {
    // Guard: UTR must not already be on any voucher
    const utrCheckRes = await fetch(
      `${supabaseUrl}/rest/v1/vouchers?utr_number=eq.${encodeURIComponent(ocrUtr!)}&select=id`,
      { headers: h },
    )
    const utrConflict = utrCheckRes.ok ? await utrCheckRes.json() as unknown[] : []
    if (!utrConflict.length) {
      // All conditions met — auto-confirm via the confirm endpoint logic
      await autoConfirm(inboxId, best.id, best.voucher_number, ocrUtr!, ocrAmount,
        best.company_id, best.entity_id, supabaseUrl, serviceKey)
      return
    }
  }

  // ── Tier 1: SUGGEST ───────────────────────────────────────────────────────
  if (best.score >= 60) {
    const confidence = best.score >= 80 ? 'high' : 'medium'
    await patchInbox(inboxId, {
      status:                 'suggested',
      suggested_voucher_id:   best.id,
      suggestion_confidence:  confidence,
    }, supabaseUrl, serviceKey)
    return
  }

  // ── Tier 2: needs_assignment ──────────────────────────────────────────────
  await patchInbox(inboxId, { status: 'needs_assignment' }, supabaseUrl, serviceKey)
}

async function autoConfirm(
  inboxId: string, voucherId: string, voucherNo: string,
  utr: string, amount: number, companyId: string, entityId: string | null,
  supabaseUrl: string, serviceKey: string,
): Promise<void> {
  const h = {
    apikey:            serviceKey,
    Authorization:     `Bearer ${serviceKey}`,
    'Content-Type':    'application/json',
    'Accept-Profile':  'pramaana',
    'Content-Profile': 'pramaana',
  }

  // Get receipt file_path for the attachment
  const inboxRow = await fetch(
    `${supabaseUrl}/rest/v1/receipt_inbox?id=eq.${inboxId}&select=file_path,ocr_date`,
    { headers: h },
  ).then(r => r.json() as Promise<{ file_path: string; ocr_date: string | null }[]>)

  const filePath = inboxRow[0]?.file_path ?? ''
  const paymentDate = inboxRow[0]?.ocr_date ?? new Date().toISOString().slice(0, 10)

  // Transition voucher → posted (paid) with UTR
  await fetch(`${supabaseUrl}/rest/v1/vouchers?id=eq.${voucherId}&status=eq.awaiting_payment`, {
    method:  'PATCH',
    headers: { ...h, Prefer: 'return=minimal' },
    body: JSON.stringify({
      status:     'posted',
      utr_number: utr,
      paid_at:    new Date(paymentDate).toISOString(),
    }),
  })

  // Attach receipt to voucher
  await fetch(`${supabaseUrl}/rest/v1/voucher_attachments`, {
    method:  'POST',
    headers: { ...h, Prefer: 'return=minimal' },
    body: JSON.stringify({
      voucher_id:   voucherId,
      company_id:   companyId,
      storage_path: filePath,
      file_name:    filePath.split('/').pop(),
      uploaded_by:  null,           // system
      attachment_type: 'transfer_receipt',
    }),
  })

  // Update inbox: attached + auto_matched
  await patchInbox(inboxId, {
    status:              'attached',
    attached_voucher_id: voucherId,
    company_id:          companyId,
    confirmed_at:        new Date().toISOString(),
    auto_matched:        true,
    amount_delta:        0,
  }, supabaseUrl, serviceKey)

  // Write audit log entry
  await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
    method:  'POST',
    headers: { ...h, Prefer: 'return=minimal' },
    body: JSON.stringify({
      table_name: 'receipt_inbox',
      record_id:  voucherId,
      company_id: companyId,
      operation:  'UPDATE',
      new_row: { note: `receipt auto-matched: ${inboxId} → ${voucherNo}, UTR ${utr}` },
      changed_via: 'service',
    }),
  })

  // Fire T3 WhatsApp (best-effort) — entityId may be null
  if (entityId) {
    const host = 'pramaana-tau.vercel.app'
    fetch(`https://${host}/api/send-whatsapp`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: 'payment-confirmed',
        mobile:   entityId,   // will be resolved in the helper
        vars:     [amount.toLocaleString('en-IN'), voucherNo],
        source:   'mode-b',
      }),
    }).catch(() => { /* best-effort */ })
  }
}

async function patchInbox(
  id: string, data: Record<string, unknown>,
  supabaseUrl: string, serviceKey: string,
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/receipt_inbox?id=eq.${id}`, {
    method:  'PATCH',
    headers: {
      apikey:            serviceKey,
      Authorization:     `Bearer ${serviceKey}`,
      'Content-Type':    'application/json',
      'Accept-Profile':  'pramaana',
      'Content-Profile': 'pramaana',
      Prefer:            'return=minimal',
    },
    body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
  })
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = env('VITE_SUPABASE_URL')
  const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')
  const openaiKey   = env('OPENAI_API_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

  const authHeader = req.headers.get('Authorization') ?? ''
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: authHeader.startsWith('Bearer ') ? authHeader : `Bearer ${serviceKey}` },
  })
  const { id: userId } = userRes.ok ? await userRes.json() as { id: string } : { id: '' }

  let body: { id?: string; fileBase64?: string; fileType?: string }
  try { body = await req.json() as typeof body } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { id: inboxId, fileBase64, fileType } = body
  if (!inboxId || !fileBase64) return json({ error: 'id and fileBase64 required' }, 400)

  const mimeType = (fileType?.startsWith('image/')) ? fileType : 'image/jpeg'

  // ── GPT-4o vision OCR ─────────────────────────────────────────────────────
  let ocrUtr: string | null = null
  let ocrAmount: number | null = null
  let ocrDate: string | null = null
  let ocrPayeeHint: string | null = null
  let ocrAccountHint: string | null = null
  let ocrRaw: unknown = null

  if (openaiKey) {
    try {
      const ocrRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model:      'gpt-4o',
          max_tokens: 512,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: RECEIPT_PROMPT },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${fileBase64}`, detail: 'high' } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (ocrRes.ok) {
        const ocrData = await ocrRes.json() as { choices?: { message?: { content?: string } }[] }
        const raw = ocrData.choices?.[0]?.message?.content ?? ''
        try {
          const parsed = JSON.parse(raw) as {
            utr?: string; amount?: number; date?: string
            payee_hint?: string; debit_account_hint?: string
          }
          ocrUtr         = parsed.utr?.trim()         || null
          ocrAmount      = typeof parsed.amount === 'number' ? parsed.amount : null
          ocrDate        = parsed.date?.trim()        || null
          ocrPayeeHint   = parsed.payee_hint?.trim()  || null
          ocrAccountHint = parsed.debit_account_hint?.trim() || null
          ocrRaw         = parsed
        } catch { /* ignore parse errors */ }
      }
    } catch { /* OCR failure is non-fatal */ }
  }

  // ── Update inbox with OCR results ─────────────────────────────────────────
  await patchInbox(inboxId, {
    status:           'extracted',
    ocr_utr:          ocrUtr,
    ocr_amount:       ocrAmount,
    ocr_date:         ocrDate,
    ocr_payee_hint:   ocrPayeeHint,
    ocr_account_hint: ocrAccountHint,
    ocr_raw:          ocrRaw,
  }, supabaseUrl, serviceKey)

  // ── Run matching ──────────────────────────────────────────────────────────
  if (userId) {
    await matchReceipt(inboxId, userId, ocrUtr, ocrAmount, supabaseUrl, serviceKey)
  } else {
    await patchInbox(inboxId, { status: 'needs_assignment' }, supabaseUrl, serviceKey)
  }

  return json({ id: inboxId, ocr_utr: ocrUtr, ocr_amount: ocrAmount })
}
