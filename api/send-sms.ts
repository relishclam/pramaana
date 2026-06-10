/**
 * Vercel Edge Function — send transactional SMS via 2Factor TSMS API.
 * POST /api/send-sms
 *
 * Body: { template, mobile, vars }
 *   template: 'payment-otp' | 'settlement-link' | 'payment-confirmed'
 *   mobile:   10-digit Indian mobile number (no country code)
 *   vars:     array of variable substitution values
 *
 * Approved DLT templates (Vilpower — Relish Hao Hao Chi Foods):
 *   Pramaana-Settlement-Link   — VAR1=name  VAR2=amount  VAR3=url
 *   Pramaana-Payment-Confirmed — VAR1=amount VAR2=voucher#
 *   Pramaana-Payment Approval  — VAR1=OTP
 */

export const config = { runtime: 'edge' }

const SENDER_ID = 'RELISH'
const API_BASE  = 'https://2factor.in/API/V1'

// Exact names as registered in Vilpower DLT — do not change spacing/casing
const TEMPLATE_NAMES: Record<string, string> = {
  'settlement-link':   'Pramaana-Settlement-Link',
  'payment-confirmed': 'Pramaana-Payment-Confirmed',
  'payment-otp':       'Pramaana-Payment Approval',   // space, not hyphen
}

async function shortenUrl(longUrl: string): Promise<string> {
  try {
    const res = await fetch(
      `https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`,
      { signal: AbortSignal.timeout(3000) },
    )
    if (!res.ok) return longUrl
    const short = (await res.text()).trim()
    return short.startsWith('http') ? short : longUrl
  } catch {
    return longUrl
  }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(null, { status: 405 })
  }

  let body: { template?: string; mobile?: string; vars?: unknown }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  const { template, mobile, vars } = body

  if (
    typeof template !== 'string' ||
    typeof mobile  !== 'string'  ||
    !Array.isArray(vars)
  ) {
    return new Response(JSON.stringify({ error: 'Missing or invalid fields' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  // process.env is available in Vercel Edge runtime
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiKey = (globalThis as any).process?.env?.TWOFACTOR_API_KEY as string | undefined
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'SMS not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  const templateName = TEMPLATE_NAMES[template]
  if (!templateName) {
    return new Response(JSON.stringify({ error: `Unknown template: ${template}` }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  // Shorten URL for settlement-link — VAR3 is the settle URL
  const finalVars: string[] = [...(vars as string[])]
  if (template === 'settlement-link' && finalVars[2]) {
    finalVars[2] = await shortenUrl(finalVars[2])
  }

  const params = new URLSearchParams({
    From:         SENDER_ID,
    To:           mobile,
    TemplateName: templateName,
    VAR1:         finalVars[0] ?? '',
    VAR2:         finalVars[1] ?? '',
    VAR3:         finalVars[2] ?? '',
  })

  const tfRes = await fetch(
    `${API_BASE}/${apiKey}/ADDON_SERVICES/SEND/TSMS`,
    { method: 'POST', body: params },
  )

  const data = await tfRes.json() as { Status: string; Details: string }

  if (data.Status !== 'Success') {
    console.error('2Factor TSMS error:', data)
    return new Response(JSON.stringify({ error: data.Details }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(
    JSON.stringify({ success: true, sessionId: data.Details }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}
