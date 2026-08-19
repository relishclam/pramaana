/**
 * api/lib/whatsapp.ts — single choke-point for all WhatsApp sends via MSG91.
 *
 * Arity guard: throws before any network call if vars.length ≠ expected.
 * TEST_MODE:   WA_TEST_MODE=true redirects ALL sends to WA_TEST_NUMBER.
 * Audit:       every attempt writes to pramaana.notification_log via service-role REST.
 * Timeout:     5s AbortSignal.timeout — WA outage must never block a voucher/query.
 * No retries:  double-messaging a payee is worse than a miss.
 */

// ── Template registry (frozen) ────────────────────────────────────────────────

export const TEMPLATE_REGISTRY = {
  pramaana_settlement_link:   { paramCount: 3, msg91Id: '461949', alias: 'TPL_SUSPENSE_SETTLEMENT' },
  pramaana_bank_recon_query:  { paramCount: 3, msg91Id: '465872', alias: 'TPL_RECON_QUERY' },
  pramaana_payment_confirmed: { paramCount: 2, msg91Id: '461944', alias: 'TPL_PAYMENT_CONFIRMED' },
} as const

export type TemplateName = keyof typeof TEMPLATE_REGISTRY

const MSG91_API = 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/'
const NAMESPACE = '63f0f6e2_780c_442c_ab96_c3cbf76a513b'

// ── Helpers ────────────────────────────────────────────────────────────────────

export function formatINR(amount: number): string {
  return Math.round(amount).toLocaleString('en-IN')
}

/** Returns '91XXXXXXXXXX' or null for invalid input. */
export function formatPhone(input: string): string | null {
  const d = input.replace(/\D/g, '')
  if (d.length === 10)                            return '91' + d
  if (d.length === 11 && d.startsWith('0'))       return '91' + d.slice(1)
  if (d.length === 12 && d.startsWith('91'))      return d
  if (d.length === 13 && d.startsWith('091'))     return d.slice(1)
  return null
}

function maskPhone(phone: string): string {
  if (phone.length < 4) return '****'
  return phone.slice(0, 2) + '****' + phone.slice(-4)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function env(k: string): string { return ((globalThis as any)?.process?.env?.[k] as string) ?? '' }

// ── Notification log ───────────────────────────────────────────────────────────

async function writeLog(
  supabaseUrl: string,
  serviceKey:  string,
  row: {
    template:           string
    msg91_template_id?: string
    recipient_masked:   string
    ref_id?:            string
    ref_type?:          string
    vars_count:         number
    test_mode:          boolean
    intended_recipient?: string
    msg91_request_id?:  string
    status:             'sent' | 'error' | 'skipped'
    error_message?:     string
  },
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/rest/v1/notification_log`, {
      method:  'POST',
      headers: {
        apikey:             serviceKey,
        Authorization:      `Bearer ${serviceKey}`,
        'Content-Profile':  'pramaana',
        'Accept-Profile':   'pramaana',
        'Content-Type':     'application/json',
        Prefer:             'return=minimal',
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(3000),
    })
  } catch (e) {
    console.error('[whatsapp] notification_log write failed:', e)
  }
}

// ── Main send ─────────────────────────────────────────────────────────────────

export interface WaSendOptions {
  template:   TemplateName
  phone:      string          // raw phone — formatPhone() is applied internally
  vars:       string[]        // must match template's paramCount exactly
  refId?:     string          // voucher_id / query_id / suspense_id for audit
  refType?:   'voucher' | 'recon_query' | 'suspense'
  source?:    string          // 'mode-a' = recorded payment (gated by WA_CONFIRM_ON_RECORDED)
}

export interface WaSendResult {
  sent:        boolean
  requestId?:  string
  skipped?:    boolean
  skipReason?: string
  error?:      string
}

export async function sendWhatsApp(
  opts:        WaSendOptions,
  supabaseUrl: string,
  serviceKey:  string,
): Promise<WaSendResult> {
  const tpl = TEMPLATE_REGISTRY[opts.template]

  // ── Arity guard (throws before any network call) ──────────────────────────
  if (opts.vars.length !== tpl.paramCount) {
    throw new Error(
      `[whatsapp] arity violation on ${opts.template}: ` +
      `expected ${tpl.paramCount} params, got ${opts.vars.length}`,
    )
  }

  // ── Mode-A gate: WA_CONFIRM_ON_RECORDED must be 'true' to fire ───────────
  if (opts.source === 'mode-a' && env('WA_CONFIRM_ON_RECORDED') !== 'true') {
    await writeLog(supabaseUrl, serviceKey, {
      template:          opts.template,
      msg91_template_id: tpl.msg91Id,
      recipient_masked:  'skipped',
      ref_id:            opts.refId,
      ref_type:          opts.refType,
      vars_count:        opts.vars.length,
      test_mode:         false,
      status:            'skipped',
      error_message:     'WA_CONFIRM_ON_RECORDED != true',
    })
    return { sent: false, skipped: true, skipReason: 'WA_CONFIRM_ON_RECORDED != true' }
  }

  // ── Env ───────────────────────────────────────────────────────────────────
  const authKey = env('MSG91_AUTH_KEY')
  const intNum  = env('MSG91_WA_INTEGRATED_NUMBER') || env('MSG91_WHATSAPP_NUMBER')
  if (!authKey || !intNum) {
    return { sent: false, error: 'WhatsApp not configured (MSG91_AUTH_KEY / MSG91_WA_INTEGRATED_NUMBER missing)' }
  }

  // ── Phone normalisation ───────────────────────────────────────────────────
  const phone = formatPhone(opts.phone)
  if (!phone) {
    await writeLog(supabaseUrl, serviceKey, {
      template:          opts.template,
      msg91_template_id: tpl.msg91Id,
      recipient_masked:  'invalid',
      ref_id: opts.refId, ref_type: opts.refType,
      vars_count: opts.vars.length, test_mode: false,
      status: 'error', error_message: `invalid phone: ${opts.phone}`,
    })
    return { sent: false, error: `Invalid phone: ${opts.phone}` }
  }

  const testMode    = env('WA_TEST_MODE') === 'true'
  const testNumber  = env('WA_TEST_NUMBER') || '919446012324'
  const actualPhone = testMode ? testNumber : phone

  // ── Payload ───────────────────────────────────────────────────────────────
  const components: Record<string, { type: string; value: string }> = {}
  opts.vars.forEach((v, i) => { components[`body_${i + 1}`] = { type: 'text', value: v } })

  const payload = {
    integrated_number: intNum,
    content_type:      'template',
    payload: {
      messaging_product: 'whatsapp',
      type:              'template',
      template: {
        name:      opts.template,
        language:  { code: 'en', policy: 'deterministic' },
        namespace: NAMESPACE,
        to_and_components: [{ to: [actualPhone], components }],
      },
    },
  }

  // ── Call MSG91 (5 s hard timeout) ─────────────────────────────────────────
  try {
    const res = await fetch(MSG91_API, {
      method:  'POST',
      headers: { authkey: authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(5000),
    })

    let data: { type?: string; message?: string; request_id?: string; [k: string]: unknown } = {}
    try { data = await res.json() as typeof data } catch { /* empty response */ }

    const requestId = (data.request_id ?? data.message) as string | undefined

    if (!res.ok || data.type === 'error') {
      const errMsg = `HTTP ${res.status}: ${data.message ?? 'unknown'}`
      await writeLog(supabaseUrl, serviceKey, {
        template: opts.template, msg91_template_id: tpl.msg91Id,
        recipient_masked: maskPhone(actualPhone),
        ref_id: opts.refId, ref_type: opts.refType,
        vars_count: opts.vars.length, test_mode: testMode,
        intended_recipient: testMode ? maskPhone(phone) : undefined,
        status: 'error', error_message: errMsg,
      })
      return { sent: false, error: errMsg }
    }

    await writeLog(supabaseUrl, serviceKey, {
      template: opts.template, msg91_template_id: tpl.msg91Id,
      recipient_masked: maskPhone(actualPhone),
      ref_id: opts.refId, ref_type: opts.refType,
      vars_count: opts.vars.length, test_mode: testMode,
      intended_recipient: testMode ? maskPhone(phone) : undefined,
      msg91_request_id: requestId,
      status: 'sent',
    })
    return { sent: true, requestId }

  } catch (e) {
    const reason = e instanceof Error ? e.message : 'timeout'
    await writeLog(supabaseUrl, serviceKey, {
      template: opts.template, msg91_template_id: tpl.msg91Id,
      recipient_masked: maskPhone(actualPhone),
      ref_id: opts.refId, ref_type: opts.refType,
      vars_count: opts.vars.length, test_mode: testMode,
      intended_recipient: testMode ? maskPhone(phone) : undefined,
      status: 'error', error_message: reason,
    })
    return { sent: false, error: reason }
  }
}
