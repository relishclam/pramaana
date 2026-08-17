/**
 * Vercel Edge Function — send WhatsApp messages via MSG91.
 * POST /api/send-whatsapp
 *
 * ROUTING RULE:
 *   Payment OTP  → send-sms (2Factor SMS only — NOT this endpoint)
 *   All other notifications → this endpoint (MSG91 WhatsApp)
 *
 * Body:
 *   {
 *     template: 'payment-confirmed' | 'settlement-link' | 'bank-recon-query',
 *     mobile:   string,   // 10-digit Indian mobile, or +91…, or 91…
 *     vars:     string[], // ordered substitution values for the template
 *   }
 *
 * Env vars required (set in Vercel project settings):
 *   MSG91_AUTH_KEY          — MSG91 API auth key
 *   MSG91_WHATSAPP_NUMBER   — Sender WhatsApp Business number incl. country code
 *                             e.g. "916282427364"
 *
 * Approved MSG91 WhatsApp templates:
 *
 *   pramaana_payment_confirmed
 *     Body:   "Relish Pramaana · Payment of Rs.{{1}} for voucher {{2}} has been
 *              processed successfully to your account."
 *     Header: "Relish Pramaana" (TEXT)
 *     Params: {{1}}=amount  {{2}}=voucher#
 *
 *   pramaana_settlement_link
 *     Body:   "Dear {{1}}, you have a pending advance of Rs.{{2}} from Relish.
 *              Please submit your expenses at: {{3}} - Thank you."
 *     Footer: "Relish Pramaana Team"
 *     Params: {{1}}=first name  {{2}}=amount  {{3}}=url
 *
 *   pramaana_bank_recon_query
 *     Body:   "Pramaana Bank Recon: Query {{1}} raised — {{2}} ({{3}} lines).
 *              Please log in to Pramaana and respond."
 *     Footer: "Relish Pramaana Team"
 *     Params: {{1}}=query#  {{2}}=subject  {{3}}=line count
 */

export const config = { runtime: 'edge' }

const MSG91_API = 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/'
const PROVIDER_TIMEOUT_MS = 12000

// Only the 3 approved templates — OTP is handled by send-sms (2Factor) not here
const TEMPLATE_NAMES: Record<string, string> = {
  'payment-confirmed': 'pramaana_payment_confirmed',
  'settlement-link':   'pramaana_settlement_link',
  'bank-recon-query':  'pramaana_bank_recon_query',
}

function env(name: string): string | undefined {
  const proc = (globalThis as Record<string, unknown>)['process'] as
    { env?: Record<string, string | undefined> } | undefined
  return proc?.env?.[name]
}

function normalizeIndianMobile(input: string): string | null {
  const digits = input.replace(/\D/g, '')
  if (digits.length === 10)                              return `91${digits}`
  if (digits.length === 11 && digits.startsWith('0'))   return `91${digits.slice(1)}`
  if (digits.length === 12 && digits.startsWith('91'))  return digits
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(1)
  return null
}

function timeoutSignal(ms: number): AbortSignal {
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), ms)
  return ctrl.signal
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(null, { status: 405 })
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: { template?: string; mobile?: string; vars?: unknown }
  try {
    body = await req.json() as typeof body
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  const { template, mobile, vars } = body

  if (
    typeof template !== 'string' ||
    typeof mobile   !== 'string' ||
    !Array.isArray(vars)
  ) {
    return new Response(JSON.stringify({ error: 'Missing or invalid fields: template, mobile, vars required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  // ── Resolve template name ───────────────────────────────────────────────────
  const templateName = TEMPLATE_NAMES[template]
  if (!templateName) {
    return new Response(JSON.stringify({ error: `Unknown template: ${template}` }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  // ── Env vars ────────────────────────────────────────────────────────────────
  const authKey       = env('MSG91_AUTH_KEY')
  const senderNumber  = env('MSG91_WHATSAPP_NUMBER')

  if (!authKey || !senderNumber) {
    return new Response(JSON.stringify({ error: 'WhatsApp not configured (missing MSG91_AUTH_KEY or MSG91_WHATSAPP_NUMBER)' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  // ── Normalize mobile ────────────────────────────────────────────────────────
  const toNumber = normalizeIndianMobile(mobile)
  if (!toNumber) {
    return new Response(JSON.stringify({ error: 'Invalid mobile number format' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  // ── Build MSG91 payload ─────────────────────────────────────────────────────
  // Each element of vars becomes a {{N}} template parameter component
  const parameters = (vars as string[]).map((text) => ({
    type: 'text',
    text: String(text),
  }))

  // /bulk/ endpoint requires payload to be an array even for a single message
  const payload = {
    integrated_number: senderNumber,
    content_type: 'template',
    payload: [
      {
        messaging_product: 'whatsapp',
        to: toNumber,
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'en' },
          components: parameters.length > 0
            ? [{ type: 'body', parameters }]
            : [],
        },
      },
    ],
  }

  // ── Call MSG91 API ──────────────────────────────────────────────────────────
  let res: Response
  try {
    res = await fetch(MSG91_API, {
      method:  'POST',
      headers: {
        'authkey':      authKey,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      body:   JSON.stringify(payload),
      signal: timeoutSignal(PROVIDER_TIMEOUT_MS),
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'timeout'
    return new Response(JSON.stringify({ error: `MSG91 request failed: ${reason}` }), {
      status: 504, headers: { 'Content-Type': 'application/json' },
    })
  }

  // ── Parse response ──────────────────────────────────────────────────────────
  let data: { type?: string; message?: string; [k: string]: unknown }
  try {
    data = await res.json() as typeof data
  } catch {
    data = {}
  }

  if (!res.ok || data.type === 'error') {
    console.error('MSG91 WhatsApp error:', JSON.stringify(data))
    return new Response(
      JSON.stringify({ error: data.message ?? `HTTP ${res.status}`, detail: data }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    )
  }

  return new Response(
    JSON.stringify({ sent: true, provider: 'msg91-whatsapp', response: data }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}
