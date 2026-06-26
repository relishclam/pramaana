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
 * Why bcryptjs (not bcrypt):
 *   The Vercel Edge Runtime is a V8 isolate — it cannot load native
 *   Node addons. bcrypt requires a native addon. bcryptjs is pure JS
 *   and works in any JS runtime including the Edge Runtime.
 */

import bcrypt from 'bcryptjs'

export const config = { runtime: 'edge' }

const SALT_ROUNDS = 10

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
    const hashed = await bcrypt.hash(otp, SALT_ROUNDS)
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
    const match = await bcrypt.compare(otp, hash)
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
