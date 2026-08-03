import { supabase } from '@/lib/supabase'
import { sendPaymentOtpSms } from '@/lib/sms'

// ── Types ─────────────────────────────────────────────────────────────────────

export type OtpInitResult =
  | { sent: true;  mobile_masked: string }
  | { sent: false; reason: string }

export type OtpVerifyResult =
  | { verified: true }
  | { verified: false; error: 'expired_or_not_found' | 'max_attempts' | 'invalid_otp'; attempts_left?: number }

// ── Internal helper — call the /api/otp edge function ────────────────────────

async function callOtpApi(
  body: { action: 'verify-2factor'; sessionId: string; otp: string }
): Promise<Record<string, unknown>> {
  const res = await fetch('/api/otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error ?? `OTP API error ${res.status}`)
  }
  return res.json() as Promise<Record<string, unknown>>
}


// ── Mask mobile number — show only last 4 digits ─────────────────────────────

function maskMobile(mobile: string): string {
  const digits = mobile.replace(/[^\d]/g, '')
  if (digits.length < 4) return '****'
  const masked = digits.slice(0, -4).replace(/\d/g, '*')
  return masked + digits.slice(-4)
}

// ── initiatePaymentOtp ───────────────────────────────────────────────────────
// Called by approveVoucher() after the admin approves.
// 1. Fetches entity mobile
// 2. Cancels any existing pending OTP session for this voucher
// 3. Sends OTP via 2Factor AUTOGEN; stores returned session_id in otp_sessions
// 4. Inserts pramaana.otp_sessions with tf_session_id

export async function initiatePaymentOtp(
  voucherId:   string,
  companyId:   string,
  initiatedBy: string,
  entityId:    string | null,
): Promise<OtpInitResult> {
  // ── 1. Resolve entity mobile ──────────────────────────────────────────────
  if (!entityId) return { sent: false, reason: 'no_entity' }

  const { data: entity } = await supabase
    .schema('registry')
    .from('entities')
    .select('mobile, display_name')
    .eq('id', entityId)
    .maybeSingle()

  if (!entity?.mobile) return { sent: false, reason: 'no_mobile' }
  const mobile = entity.mobile as string

  // Fetch voucher amount for SMS template var2
  const { data: voucherRow } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .select('amount')
    .eq('id', voucherId)
    .maybeSingle()
  const voucherAmount = (voucherRow?.amount as number) ?? 0

  // ── 2. Cancel any existing pending session for this voucher ──────────────
  await supabase
    .schema('pramaana')
    .from('otp_sessions')
    .update({ status: 'cancelled' })
    .eq('voucher_id', voucherId)
    .eq('status', 'pending')

  // ── 3. Generate OTP + hash via edge function ──────────────────────────────
  // -- 3. Send OTP via 2Factor AUTOGEN --
  const smsResult = await sendPaymentOtpSms(mobile, (entity.display_name as string) ?? "", voucherAmount)

  if (!smsResult.sent) {
    console.warn("[otp] SMS send failed:", "reason" in smsResult ? smsResult.reason : "unknown")
    return { sent: false, reason: "sms_failed" }
  }

  const tfSessionId = smsResult.sessionId ?? ""

  // -- 4. Insert otp_sessions row --
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  const { error: insertErr } = await supabase
    .schema("pramaana")
    .from("otp_sessions")
    .insert({
      voucher_id:      voucherId,
      company_id:      companyId,
      initiated_by:    initiatedBy,
      mobile,
      tf_session_id:   tfSessionId,
      expires_at:      expiresAt,
      status:          "pending",
      failed_attempts: 0,
    })

  if (insertErr) {
    console.error("[otp] insert error:", insertErr.message)
    return { sent: false, reason: "db_error" }
  }

  return { sent: true, mobile_masked: maskMobile(mobile) }
}

// ── verifyPaymentOtp ─────────────────────────────────────────────────────────
// Called from the OTP panel in ApprovalQueue after admin enters the code
// that the payee reads out.
// 1. Fetches the active pending session
// 2. Checks attempt count (max 3)
// 3. Calls /api/otp to compare plain OTP against hash
// 4. On match: marks session verified + advances voucher to 'completed'
// 5. On mismatch: increments failed_attempts

export async function verifyPaymentOtp(
  voucherId:  string,
  plainOtp:   string,
  verifiedBy: string,
): Promise<OtpVerifyResult> {
  // ── 1. Fetch active session ───────────────────────────────────────────────
  type SessionRow = {
    id: string
    tf_session_id: string
    failed_attempts: number
    expires_at: string
  }

  const { data: session, error: fetchErr } = await supabase
    .schema('pramaana')
    .from('otp_sessions')
    .select('id, tf_session_id, failed_attempts, expires_at')
    .eq('voucher_id', voucherId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (fetchErr || !session) {
    return { verified: false, error: 'expired_or_not_found' }
  }

  const s = session as SessionRow

  // ── 2. Check attempt limit ────────────────────────────────────────────────
  if (s.failed_attempts >= 3) {
    // Lock the session
    await supabase
      .schema('pramaana')
      .from('otp_sessions')
      .update({ status: 'expired' })
      .eq('id', s.id)
    return { verified: false, error: 'max_attempts' }
  }

  // ── 3. Verify OTP via edge function ──────────────────────────────────────
  let match = false
  try {
    const result = await callOtpApi({ action: 'verify-2factor', sessionId: s.tf_session_id, otp: plainOtp })
    match = result.match as boolean
  } catch (err) {
    console.error('[otp] verify error:', err)
    return { verified: false, error: 'expired_or_not_found' }
  }

  // ── 4a. Mismatch — increment attempts ────────────────────────────────────
  if (!match) {
    const newAttempts = s.failed_attempts + 1
    await supabase
      .schema('pramaana')
      .from('otp_sessions')
      .update({ failed_attempts: newAttempts })
      .eq('id', s.id)

    const attemptsLeft = 3 - newAttempts
    return { verified: false, error: 'invalid_otp', attempts_left: Math.max(0, attemptsLeft) }
  }

  // ── 4b. Match — mark verified + advance voucher ──────────────────────────
  const now = new Date().toISOString()

  const { error: sessionErr } = await supabase
    .schema('pramaana')
    .from('otp_sessions')
    .update({ status: 'verified', verified_at: now })
    .eq('id', s.id)

  if (sessionErr) {
    console.error('[otp] session update error:', sessionErr.message)
    return { verified: false, error: 'expired_or_not_found' }
  }

  const { error: voucherErr } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update({
      status:            'completed',
      otp_verified_at:   now,
      otp_verified_by:   verifiedBy,
      completed_at:      now,
      completed_by:      verifiedBy,
    })
    .eq('id', voucherId)
    .eq('status', 'approved')

  if (voucherErr) {
    console.error('[otp] voucher update error:', voucherErr.message)
    // Session is verified — don't fail the whole flow over this
  }

  return { verified: true }
}
