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
  body: { action: 'hash'; otp: string } | { action: 'verify'; otp: string; hash: string }
): Promise<Record<string, unknown>> {
  // PRAMAANA_OTP_SECRET is not available in the browser — this function
  // is only called from server-side contexts. In the browser (Vite dev
  // and production), we rely on Vercel routing /api/otp to the edge fn.
  // The edge fn reads the secret from process.env server-side.
  // We pass it here as an internal header via the same-origin call.
  const secret = import.meta.env.VITE_OTP_INTERNAL_SECRET ?? ''
  const res = await fetch('/api/otp', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'X-Internal-Secret': secret,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error ?? `OTP API error ${res.status}`)
  }
  return res.json() as Promise<Record<string, unknown>>
}

// ── Generate a 6-digit OTP ───────────────────────────────────────────────────

function generateOtp(): string {
  // crypto.getRandomValues is available in all modern browsers + edge runtimes
  const array = new Uint32Array(1)
  crypto.getRandomValues(array)
  // Range 100000–999999
  return String(100000 + (array[0] % 900000))
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
// 3. Generates + hashes a 6-digit OTP
// 4. Inserts pramaana.otp_sessions
// 5. Sends SMS via 2Factor

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
    .select('mobile')
    .eq('id', entityId)
    .maybeSingle()

  if (!entity?.mobile) return { sent: false, reason: 'no_mobile' }
  const mobile = entity.mobile as string

  // ── 2. Cancel any existing pending session for this voucher ──────────────
  await supabase
    .schema('pramaana')
    .from('otp_sessions')
    .update({ status: 'cancelled' })
    .eq('voucher_id', voucherId)
    .eq('status', 'pending')

  // ── 3. Generate OTP + hash via edge function ──────────────────────────────
  const plainOtp = generateOtp()
  let otpHash: string
  try {
    const result = await callOtpApi({ action: 'hash', otp: plainOtp })
    otpHash = result.hash as string
  } catch (err) {
    console.error('[otp] hash error:', err)
    return { sent: false, reason: 'hash_failed' }
  }

  // ── 4. Insert otp_sessions row ────────────────────────────────────────────
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 minutes

  const { error: insertErr } = await supabase
    .schema('pramaana')
    .from('otp_sessions')
    .insert({
      voucher_id:    voucherId,
      company_id:    companyId,
      initiated_by:  initiatedBy,
      mobile,
      otp_hash:      otpHash,
      expires_at:    expiresAt,
      status:        'pending',
      failed_attempts: 0,
    })

  if (insertErr) {
    console.error('[otp] insert error:', insertErr.message)
    return { sent: false, reason: 'db_error' }
  }

  // ── 5. Send SMS ───────────────────────────────────────────────────────────
  const smsResult = await sendPaymentOtpSms(mobile, plainOtp)

  if (!smsResult.sent) {
    // OTP row inserted but SMS failed — session exists, user can resend
    console.warn('[otp] SMS send failed:', 'reason' in smsResult ? smsResult.reason : 'unknown')
    return { sent: false, reason: 'sms_failed' }
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
    otp_hash: string
    failed_attempts: number
    expires_at: string
  }

  const { data: session, error: fetchErr } = await supabase
    .schema('pramaana')
    .from('otp_sessions')
    .select('id, otp_hash, failed_attempts, expires_at')
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
    const result = await callOtpApi({ action: 'verify', otp: plainOtp, hash: s.otp_hash })
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
