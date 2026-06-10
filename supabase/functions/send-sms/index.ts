/**
 * send-sms — Supabase Edge Function (Deno)
 *
 * Sends transactional SMS via 2Factor TSMS API.
 * URL variables are shortened via TinyURL before sending.
 *
 * Required Supabase secrets (set in dashboard → Edge Functions → Secrets):
 *   TWOFACTOR_API_KEY       — 2Factor API key
 *   SMS_ENABLED             — "true" to actually send; omit or "false" to dry-run
 *   APP_ORIGIN              — e.g. https://pramaana-tau.vercel.app (no trailing slash)
 *
 * Supabase built-ins (auto-injected):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Invoked from the browser via supabase.functions.invoke('send-sms', { body: ... })
 * The user's JWT is forwarded automatically by the Supabase client — we verify it
 * server-side so only authenticated users can trigger SMS sends.
 */

import { serve }         from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient }  from 'https://esm.sh/@supabase/supabase-js@2'

// ── Env ───────────────────────────────────────────────────────────────────────

const TWOFACTOR_API_KEY    = Deno.env.get('TWOFACTOR_API_KEY')    ?? ''
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')         ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const SMS_ENABLED          = Deno.env.get('SMS_ENABLED') === 'true'
const APP_ORIGIN           = (Deno.env.get('APP_ORIGIN') ?? 'https://pramaana-tau.vercel.app').replace(/\/$/, '')

const SENDER_ID = 'Relish'

// ── CORS ──────────────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Template definitions ──────────────────────────────────────────────────────

type Template = 'settlement-link' | 'payment-confirmed'

interface SmsRequest {
  template:    Template
  entity_id:   string
  amount?:     number
  token?:      string   // settlement-link only
  voucher_no?: string   // payment-confirmed only
}

// ── URL shortener (TinyURL free endpoint) ─────────────────────────────────────
// Returns short URL like https://tinyurl.com/2xxxxxxx (~27 chars)
// Falls back to the full URL if the API is unavailable.

async function shortenUrl(url: string): Promise<string> {
  try {
    const res = await fetch(
      `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(4000) },
    )
    if (!res.ok) return url
    const short = (await res.text()).trim()
    return short.startsWith('http') ? short : url
  } catch {
    return url
  }
}

// ── 2Factor TSMS call ─────────────────────────────────────────────────────────

async function send2Factor(
  phone:        string,
  templateName: string,
  vars:         Record<string, string>,
): Promise<void> {
  const normalised = phone.replace(/\D/g, '')
  const to = normalised.startsWith('91') ? normalised : `91${normalised}`

  const body = {
    From:         SENDER_ID,
    To:           to,
    TemplateName: templateName,
    ...vars,
  }

  const res  = await fetch(
    `https://2factor.in/API/V1/${TWOFACTOR_API_KEY}/ADDON_SERVICES/SEND/TSMS`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    },
  )
  const data = await res.json()
  if (!res.ok || data.Status !== 'Success') {
    throw new Error(`2Factor error: ${data.Details ?? JSON.stringify(data)}`)
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  // ── Verify caller is authenticated ─────────────────────────────────────────
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized' }, 401)
  }
  const jwt = authHeader.replace('Bearer ', '')
  const anonClient = createClient(SUPABASE_URL, jwt)
  const { data: { user }, error: authErr } = await anonClient.auth.getUser()
  if (authErr || !user) {
    return json({ error: 'Invalid token' }, 401)
  }

  // ── Parse request body ──────────────────────────────────────────────────────
  let body: SmsRequest
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  if (!body.entity_id || !body.template) {
    return json({ error: 'Missing required fields: entity_id, template' }, 400)
  }

  // ── Look up entity mobile via service-role client ──────────────────────────
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const { data: entity, error: entErr } = await serviceClient
    .schema('registry')
    .from('entities')
    .select('display_name, mobile')
    .eq('id', body.entity_id)
    .single()

  if (entErr || !entity) {
    return json({ error: 'Entity not found' }, 404)
  }

  if (!entity.mobile) {
    // Not an error — caller should silently skip
    return json({ success: false, reason: 'no_mobile' })
  }

  // ── Dry-run gate (DLT templates pending approval) ─────────────────────────
  if (!SMS_ENABLED) {
    console.log(
      `[send-sms] DRY RUN — template=${body.template} to=${entity.mobile}`,
      `amount=${body.amount} token=${body.token ?? ''} voucher=${body.voucher_no ?? ''}`,
    )
    return json({ success: true, dryRun: true })
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  try {
    if (body.template === 'settlement-link') {
      if (!body.token || body.amount === undefined) {
        return json({ error: 'token and amount required for settlement-link' }, 400)
      }
      const fullUrl  = `${APP_ORIGIN}/settle/${body.token}`
      const shortUrl = await shortenUrl(fullUrl)
      await send2Factor(entity.mobile, 'Pramaana-Settlement-Link', {
        VAR1: entity.display_name,
        VAR2: String(Math.round(body.amount)),
        VAR3: shortUrl,
      })
    } else if (body.template === 'payment-confirmed') {
      if (body.amount === undefined || !body.voucher_no) {
        return json({ error: 'amount and voucher_no required for payment-confirmed' }, 400)
      }
      await send2Factor(entity.mobile, 'Pramaana-Payment-Confirmed', {
        VAR1: String(Math.round(body.amount)),
        VAR2: body.voucher_no,
      })
    } else {
      return json({ error: `Unknown template: ${body.template}` }, 400)
    }

    return json({ success: true })
  } catch (err) {
    console.error('[send-sms] send error:', err)
    return json({ error: String(err) }, 500)
  }
})
