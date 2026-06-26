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

function env(name: string): string | undefined {
  // Works in Vercel edge + local dev shims
  const procEnv = typeof process !== 'undefined' ? process.env?.[name] : undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalEnv = (globalThis as any)?.process?.env?.[name] as string | undefined
  return procEnv ?? globalEnv
}

function normalizeIndianMobile(input: string): string | null {
  const digits = input.replace(/\D/g, '')
  if (digits.length === 10) return digits
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  return null
}

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

  const apiKey =
    env('TWOFACTOR_API_KEY') ??
    env('TWO_FACTOR_API_KEY') ??
    env('SMS_API_KEY')

  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'SMS not configured (missing TWOFACTOR_API_KEY)' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  const otpTemplateFromEnv = env('TWOFACTOR_TEMPLATE_NAME')
  const templateName =
    template === 'payment-otp' && otpTemplateFromEnv
      ? otpTemplateFromEnv
      : TEMPLATE_NAMES[template]

  if (!templateName) {
    return new Response(JSON.stringify({ error: `Unknown template: ${template}` }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  const normalizedMobile = normalizeIndianMobile(mobile)
  if (!normalizedMobile) {
    return new Response(JSON.stringify({ error: 'Invalid mobile number format' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // ── OTP templates: use 2Factor dedicated OTP API endpoint ────────────────
  // OTP templates registered under "OTP Templates" in 2Factor dashboard
  // MUST use the /SMS/{phone}/{otp}/{template} URL — NOT the TSMS endpoint.
  // TSMS returns "Success" silently for OTP templates without delivering.
  if (template === 'payment-otp') {
    const otp = (vars as string[])[0] ?? ''
    const otpUrl = `${API_BASE}/${apiKey}/SMS/${normalizedMobile}/${encodeURIComponent(otp)}/${encodeURIComponent(templateName)}`

    const tfRes = await fetch(otpUrl, { method: 'GET' })
    const data = await tfRes.json() as { Status: string; Details: string }

    if (data.Status !== 'Success') {
      console.error('2Factor OTP API error:', data)
      return new Response(JSON.stringify({ error: data.Details }), {
        status: 502, headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(
      JSON.stringify({ success: true, sessionId: data.Details }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // ── Non-OTP transactional templates: use TSMS endpoint ────────────────────
  const finalVars: string[] = [...(vars as string[])]
  if (template === 'settlement-link' && finalVars[2]) {
    finalVars[2] = await shortenUrl(finalVars[2])
  }

  const params = new URLSearchParams({
    From:         SENDER_ID,
    To:           normalizedMobile,
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
