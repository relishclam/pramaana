/**
 * Vercel Edge Function — bcrypt hash/verify for payment OTPs.
 * POST /api/otp
 *
 * Body: { action: 'hash', otp: string }
 *    → { hash: string }
 *
 * Body: { action: 'verify', otp: string, hash: string }
 *    → { match: boolean }
 *
 * Security:
 *   This endpoint is intentionally same-origin callable from the browser.
 *   It performs no privileged data access — only bcrypt hash/compare.
 *   OTP correctness is still enforced by the pramaana.otp_sessions lookup
 *   and voucher state transitions in the app/database layer.
 *
 * Implementation note:
 *   This endpoint uses Web Crypto instead of bcrypt to stay fully
 *   compatible with the Vercel Edge runtime. The stored value is a
 *   salted SHA-256 string in the format `salt:hash`.
 */

export const config = { runtime: 'edge' }

const TWO_FACTOR_API_BASE = 'https://2factor.in/API/V1'

function env(name: string): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any)?.process?.env?.[name] as string | undefined
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return bytesToHex(new Uint8Array(digest))
}

async function hashOtp(otp: string): Promise<string> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16))
  const salt = bytesToHex(saltBytes)
  const hash = await sha256Hex(`${salt}:${otp}`)
  return `${salt}:${hash}`
}

async function verifyOtp(otp: string, stored: string): Promise<boolean> {
  const [salt, existingHash] = stored.split(':')
  if (!salt || !existingHash) return false
  const computed = await sha256Hex(`${salt}:${otp}`)
  const a = hexToBytes(existingHash)
  const b = hexToBytes(computed)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(null, { status: 405 })
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: { action?: string; otp?: string; hash?: string; sessionId?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { action, otp, hash, sessionId } = body

  if (typeof action !== 'string' || typeof otp !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing action or otp' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // ── Hash ──────────────────────────────────────────────────────────────────
  if (action === 'hash') {
    const hashed = await hashOtp(otp)
    return new Response(JSON.stringify({ hash: hashed }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  if (action === 'verify') {
    if (typeof hash !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing hash for verify' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const match = await verifyOtp(otp, hash)
    return new Response(JSON.stringify({ match }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // ── Verify OTP via MSG91 ────────────────────────────────────────────────────
  // sessionId = '91XXXXXXXXXX' (the mobile number, set by send-sms.ts)
  if (action === 'verify-2factor') {
    if (typeof sessionId !== 'string' || typeof otp !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing sessionId or otp' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const authKey = env('MSG91_AUTH_KEY')
    if (!authKey) {
      return new Response(JSON.stringify({ error: 'SMS not configured (missing MSG91_AUTH_KEY)' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const verifyUrl = `https://control.msg91.com/api/v5/otp/verify?authkey=${encodeURIComponent(authKey)}&mobile=${encodeURIComponent(sessionId)}&otp=${encodeURIComponent(otp)}`
    let res: Response
    try {
      res = await fetch(verifyUrl, { method: 'GET', signal: AbortSignal.timeout(12000) })
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'timeout'
      return new Response(JSON.stringify({ error: `MSG91 verify request failed: ${reason}` }), {
        status: 504,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    let data: { type?: string; message?: string } = {}
    try { data = await res.json() as typeof data } catch { /* empty */ }
    return new Response(JSON.stringify({ match: data.type === 'success' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
}
