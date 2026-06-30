/**
 * SMS client helpers — call the /api/send-sms Vercel Edge Function.
 * All functions are fire-and-forget safe: they never throw.
 * API key stays server-side in the Edge Function; never exposed to the browser.
 *
 * DLT templates approved 2026-06-10 (Vilpower — Relish Hao Hao Chi Foods):
 *   Pramaana-Settlement-Link   | Pramaana-Payment-Confirmed | Pramaana-Payment Approval
 */
import { supabase } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

export type SmsResult =
  | { sent: true;  dryRun?: boolean }
  | { sent: false; reason: string }

const API_TIMEOUT_MS = 15000

// ── Core caller ───────────────────────────────────────────────────────────────

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
  otp:       string,
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
      body:    JSON.stringify({ template: 'payment-otp', mobile, otp, var1: safeName, var2: amountStr }),
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
    console.warn('[sms] OTP send failed:', e)
    return { sent: false, reason: e instanceof Error ? e.message : 'error' }
  }
}
