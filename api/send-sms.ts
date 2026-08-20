/**
 * Vercel Edge Function — send transactional SMS via MSG91.
 * POST /api/send-sms
 *
 * Body: { template, mobile, vars }
 *   template: 'payment-otp' | 'settlement-link' | 'payment-confirmed'
 *   mobile:   10-digit Indian mobile number (no country code)
 *   vars:     array of variable substitution values
 *
 * Env vars required:
 *   MSG91_AUTH_KEY        — MSG91 authentication key
 *   MSG91_OTP_TEMPLATE_ID — MSG91 OTP template ID (for payment-otp)
 *   MSG91_SENDER          — DLT sender ID
 *   MSG91_FLOW_ID         — MSG91 flow ID (for non-OTP templates)
 */

// Edge runtime required — Web fetch API (return new Response) is ignored on Node.js runtime
export const config = { runtime: 'edge', maxDuration: 30 }

const MSG91_OTP_API  = 'https://control.msg91.com/api/v5/otp'
const MSG91_FLOW_API = 'https://api.msg91.com/api/v5/flow/'

const PROVIDER_TIMEOUT_MS = 15000

function env(name: string): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any)?.process?.env?.[name] as string | undefined
}

function normalizeIndianMobile(input: string): string | null {
  const digits = input.replace(/\D/g, '')
  if (digits.length === 10) return digits
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  return null
}

// Returns '91XXXXXXXXXX' for MSG91 API calls
function toMsg91Mobile(mobile: string): string {
  return '91' + mobile
}

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

async function parse2FactorResponse(res: Response): Promise<{ Status?: string; Details?: string }> {
  const text = await res.text()
  if (!text) return { Status: 'Error', Details: `HTTP ${res.status}` }
  try {
    const data = JSON.parse(text) as { Status?: string; Details?: string }
    return data
  } catch {
    return { Status: res.ok ? 'Success' : 'Error', Details: text }
  }
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

  let body: { template?: string; mobile?: string; vars?: unknown; var1?: string; var2?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  const { template, mobile, vars } = body

  if (typeof template !== 'string' || typeof mobile !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing or invalid fields' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  if (template !== 'payment-otp' && !Array.isArray(vars)) {
    return new Response(JSON.stringify({ error: 'Missing or invalid fields' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  const authKey = env('MSG91_AUTH_KEY')
  if (!authKey) {
    return new Response(JSON.stringify({ error: 'SMS not configured (missing MSG91_AUTH_KEY)' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  const normalizedMobile = normalizeIndianMobile(mobile)
  if (!normalizedMobile) {
    return new Response(JSON.stringify({ error: 'Invalid mobile number format' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  const msg91Mobile = toMsg91Mobile(normalizedMobile)

  // ── OTP: use MSG91 OTP API — auto-generates and sends OTP ─────────────────
  // sessionId returned is the mobile number; MSG91 tracks the OTP session internally.
  if (template === 'payment-otp') {
    const templateId = env('MSG91_OTP_TEMPLATE_ID')
    const sender     = env('MSG91_SENDER')
    if (!templateId) {
      return new Response(JSON.stringify({ error: 'SMS not configured (missing MSG91_OTP_TEMPLATE_ID)' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }

    let otpRes: Response
    try {
      otpRes = await fetch(MSG91_OTP_API, {
        method: 'POST',
        headers: { authkey: authKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: templateId,
          mobile:      msg91Mobile,
          ...(sender ? { sender } : {}),
        }),
        signal: timeoutSignal(PROVIDER_TIMEOUT_MS),
      })
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'timeout'
      return new Response(JSON.stringify({ error: `MSG91 OTP request failed: ${reason}` }), {
        status: 504, headers: { 'Content-Type': 'application/json' },
      })
    }

    let data: { type?: string; message?: string } = {}
    try { data = await otpRes.json() as typeof data } catch { /* empty */ }

    if (!otpRes.ok || data.type === 'error') {
      console.error('MSG91 OTP API error:', data)
      return new Response(JSON.stringify({ error: data.message ?? `HTTP ${otpRes.status}` }), {
        status: 502, headers: { 'Content-Type': 'application/json' },
      })
    }

    // sessionId = mobile number — used by otp.ts verify-msg91 to verify the entered OTP
    return new Response(
      JSON.stringify({ success: true, sessionId: msg91Mobile }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // ── Non-OTP transactional SMS: use MSG91 Flow API ─────────────────────────
  const flowId = env('MSG91_FLOW_ID')
  const sender  = env('MSG91_SENDER')
  if (!flowId) {
    return new Response(JSON.stringify({ error: 'SMS not configured (missing MSG91_FLOW_ID)' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  const finalVars: string[] = [...(vars as string[])]
  if (template === 'settlement-link' && finalVars[2]) {
    finalVars[2] = await shortenUrl(finalVars[2])
  }

  const recipient: Record<string, string> = { mobiles: msg91Mobile }
  finalVars.forEach((v, i) => { recipient[`var${i + 1}`] = v })

  let tfRes: Response
  try {
    tfRes = await fetch(MSG91_FLOW_API, {
      method: 'POST',
      headers: { authkey: authKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flow_id:    flowId,
        ...(sender ? { sender } : {}),
        recipients: [recipient],
      }),
      signal: timeoutSignal(PROVIDER_TIMEOUT_MS),
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'timeout'
    return new Response(JSON.stringify({ error: `MSG91 Flow SMS request failed: ${reason}` }), {
      status: 504, headers: { 'Content-Type': 'application/json' },
    })
  }

  let data: { type?: string; message?: string; request_id?: string } = {}
  try { data = await tfRes.json() as typeof data } catch { /* empty */ }

  if (!tfRes.ok || data.type === 'error') {
    console.error('MSG91 Flow SMS error:', data)
    return new Response(JSON.stringify({ error: data.message ?? `HTTP ${tfRes.status}` }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(
    JSON.stringify({ success: true, requestId: data.request_id ?? data.message }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}
