/**
 * POST /api/send-whatsapp
 * HTTP endpoint for browser-side WhatsApp sends (T1 settlement link, T3 payment confirmed).
 * Server-side code (T2 bank recon query) imports api/lib/whatsapp.ts directly.
 *
 * Body: { template, mobile, vars, source? }
 *   template: 'payment-confirmed' | 'settlement-link' | 'bank-recon-query'
 *   mobile:   Indian mobile (any normalised form)
 *   vars:     positional substitution values — MUST match template arity exactly
 *   source?:  'mode-a' (recorded payment — gated by WA_CONFIRM_ON_RECORDED env)
 */

// Edge runtime required — Web fetch API (return new Response) is ignored on Node.js runtime
export const config = { runtime: 'edge', maxDuration: 10 }

import {
  sendWhatsApp,
  TEMPLATE_REGISTRY,
  type TemplateName,
} from './lib/whatsapp.js'

// Map HTTP-friendly aliases to MSG91 template names
const ALIAS_MAP: Record<string, TemplateName> = {
  'payment-confirmed': 'pramaana_payment_confirmed',
  'settlement-link':   'pramaana_settlement_link',
  'bank-recon-query':  'pramaana_bank_recon_query',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function env(k: string): string { return ((globalThis as any)?.process?.env?.[k] as string) ?? '' }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response(null, { status: 405 })

  let body: { template?: string; mobile?: string; vars?: unknown; source?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const { template, mobile, vars, source } = body

  if (typeof template !== 'string' || typeof mobile !== 'string' || !Array.isArray(vars)) {
    return json({ error: 'template, mobile, vars required' }, 400)
  }

  const templateName = ALIAS_MAP[template]
  if (!templateName) return json({ error: `Unknown template alias: ${template}` }, 400)

  // Arity pre-check — return 400 before any network call
  const expected = TEMPLATE_REGISTRY[templateName].paramCount
  if ((vars as unknown[]).length !== expected) {
    return json({
      error: `Arity mismatch for ${template}: expected ${expected} vars, got ${(vars as unknown[]).length}`,
    }, 400)
  }

  const supabaseUrl = env('VITE_SUPABASE_URL')
  const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY')

  let result
  try {
    result = await sendWhatsApp(
      { template: templateName, phone: mobile, vars: vars as string[], source },
      supabaseUrl,
      serviceKey,
    )
  } catch (e) {
    // Only thrown for arity violations (programming error)
    return json({ error: e instanceof Error ? e.message : 'Internal error' }, 500)
  }

  if (result.skipped)  return json({ skipped: true, reason: result.skipReason }, 200)
  if (!result.sent)    return json({ error: result.error }, 502)
  return json({ sent: true, requestId: result.requestId }, 200)
}
