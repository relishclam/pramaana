/**
 * SMS + WhatsApp client helpers.
 *
 * SMS  → /api/send-sms      (2Factor TSMS / OTP API)
 * WA   → /api/send-whatsapp (MSG91 WhatsApp Business API)
 *
 * All functions are fire-and-forget safe: they never throw.
 * API keys stay server-side in Edge Functions; never exposed to the browser.
 *
 * DLT templates (Vilpower — Relish Hao Hao Chi Foods):
 *   Pramaana-Settlement-Link | Pramaana-Payment-Confirmed | Pramaana-Payment-OTP2
 *
 * MSG91 WhatsApp templates (pre-approved in MSG91 dashboard):
 *   pramaana_payment_confirmed | pramaana_settlement_link
 */
import { supabase } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

export type SmsResult =
  | { sent: true;  dryRun?: boolean; sessionId?: string }
  | { sent: false; reason: string }

const API_TIMEOUT_MS = 28000

// ── Core SMS caller ───────────────────────────────────────────────────────────

async function callApi(
  template: 'settlement-link' | 'payment-confirmed' | 'payment-otp',
  mobile:   string,
  vars:     string[],
): Promise<SmsResult> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS)
    const res = await fetch('/api/send-sms', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ template, mobile, vars }),
      signal:  ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string }
      return { sent: false, reason: err.error ?? `HTTP ${res.status}` }
    }
    return { sent: true }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { sent: false, reason: 'SMS request timed out' }
    }
    console.warn('[sms] send failed:', e)
    return { sent: false, reason: e instanceof Error ? e.message : 'error' }
  }
}

// ── Settlement link ───────────────────────────────────────────────────────────
// Template: Pramaana-Settlement-Link
// "Dear {name}, You have a pending advance of Rs.{amount} from Relish.
//  Submit expenses at {url}"

export async function sendSettlementLinkSms(
  entityId: string,
  amount:   number,
  token:    string,
): Promise<SmsResult> {
  const { data: entity } = await supabase
    .schema('registry')
    .from('entities')
    .select('display_name, mobile')
    .eq('id', entityId)
    .maybeSingle()

  if (!entity?.mobile) return { sent: false, reason: 'no_mobile' }

  const url       = `${window.location.origin}/settle/${token}`
  const firstName = (entity.display_name as string ?? '').split(' ')[0]
  const amountStr = Math.round(amount).toLocaleString('en-IN')

  return callApi('settlement-link', entity.mobile as string, [firstName, amountStr, url])
}

// ── Payment confirmed ─────────────────────────────────────────────────────────
// Template: Pramaana-Payment-Confirmed
// "Relish-Pramaana: Payment Rs.{amount} for voucher {voucherNo}
//  processed successfully to your account."

export async function sendPaymentConfirmedSms(
  entityId:  string,
  amount:    number,
  voucherNo: string,
): Promise<SmsResult> {
  const { data: entity } = await supabase
    .schema('registry')
    .from('entities')
    .select('mobile')
    .eq('id', entityId)
    .maybeSingle()

  if (!entity?.mobile) return { sent: false, reason: 'no_mobile' }

  const amountStr = Math.round(amount).toLocaleString('en-IN')
  return callApi('payment-confirmed', entity.mobile as string, [amountStr, voucherNo])
}

// ── Payment OTP ───────────────────────────────────────────────────────────────
// Template: Pramaana-Payment-OTP2 (Sender: RHHF)
// 'Dear #VAR1#, Relish payment of Rs.#VAR2# approved. Your OTP is XXXX.
//  Valid for 10 minutes. Do not share.'

export async function sendPaymentOtpSms(
  mobile:    string,
  payeeName: string,
  amount:    number,
): Promise<SmsResult> {
  const safeName  = payeeName.slice(0, 30)
  const amountStr = Math.round(amount).toString()
  try {
    const ctrl  = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS)
    const res = await fetch('/api/send-sms', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ template: 'payment-otp', mobile, var1: safeName, var2: amountStr }),
      signal:  ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string }
      return { sent: false, reason: err.error ?? `HTTP ${res.status}` }
    }
    const data = await res.json() as { sessionId?: string }
    return { sent: true, sessionId: data.sessionId }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { sent: false, reason: 'SMS request timed out' }
    }
    console.warn('[sms] OTP send failed:', e)
    return { sent: false, reason: e instanceof Error ? e.message : 'error' }
  }
}

// ── WhatsApp via MSG91 ────────────────────────────────────────────────────────

async function callWhatsApp(
  template: 'payment-confirmed' | 'settlement-link',
  mobile:   string,
  vars:     string[],
): Promise<SmsResult> {
  try {
    const ctrl  = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS)
    const res = await fetch('/api/send-whatsapp', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ template, mobile, vars }),
      signal:  ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string }
      return { sent: false, reason: err.error ?? `HTTP ${res.status}` }
    }
    return { sent: true }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { sent: false, reason: 'WhatsApp request timed out' }
    }
    console.warn('[whatsapp] send failed:', e)
    return { sent: false, reason: e instanceof Error ? e.message : 'error' }
  }
}

// ── WhatsApp: Payment Confirmed ───────────────────────────────────────────────
// Template: pramaana_payment_confirmed
// Body:     "Relish Pramaana: Payment of Rs.{{1}} for voucher {{2}} has been
//            processed successfully to your account."
// Params:   {{1}}=amount  {{2}}=voucher#

export async function sendPaymentConfirmedWhatsApp(
  entityId:  string,
  amount:    number,
  voucherNo: string,
): Promise<SmsResult> {
  const { data: entity } = await supabase
    .schema('registry')
    .from('entities')
    .select('mobile')
    .eq('id', entityId)
    .maybeSingle()

  if (!entity?.mobile) return { sent: false, reason: 'no_mobile' }

  return callWhatsApp('payment-confirmed', entity.mobile as string, [
    Math.round(amount).toLocaleString('en-IN'),
    voucherNo,
  ])
}

// ── WhatsApp: Settlement Link ─────────────────────────────────────────────────
// Template: pramaana_settlement_link
// Body:     "Dear {{1}}, you have a pending advance of Rs.{{2}} from Relish.
//            Please submit your expenses at: {{3}}"
// Params:   {{1}}=first name  {{2}}=amount  {{3}}=url

export async function sendSettlementLinkWhatsApp(
  entityId: string,
  amount:   number,
  token:    string,
): Promise<SmsResult> {
  const { data: entity } = await supabase
    .schema('registry')
    .from('entities')
    .select('display_name, mobile')
    .eq('id', entityId)
    .maybeSingle()

  if (!entity?.mobile) return { sent: false, reason: 'no_mobile' }

  const firstName = (entity.display_name as string ?? '').split(' ')[0]
  const url       = `${window.location.origin}/settle/${token}`

  return callWhatsApp('settlement-link', entity.mobile as string, [
    firstName,
    Math.round(amount).toLocaleString('en-IN'),
    url,
  ])
}
