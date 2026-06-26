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
  let body: { action?: string; otp?: string; hash?: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { action, otp, hash } = body

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

  return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
}
