import { supabase } from '@/lib/supabase'
import { initiatePaymentOtp, type OtpInitResult } from '@/lib/otp'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingVoucher {
  id: string
  voucher_number: string
  voucher_date: string
  amount: number
  status: string
  narration: string | null
  created_at: string
  entity_id: string | null
  created_by: string
  // resolved
  created_by_name: string
  entity_name:     string | null
  entity_mobile:   string | null
  voucher_type: { id: string; code: string; name: string; nature: string }
}

export interface VoucherEntryDetail {
  id: string
  ledger_name: string
  group_name: string | null
  group_nature: string | null
  entry_type: 'Dr' | 'Cr'
  amount: number
  narration: string | null
  sort_order: number
}

export interface ApprovalHistoryItem {
  id: string
  action: 'submitted' | 'approved' | 'rejected'
  actioned_by_name: string
  comments: string | null
  actioned_at: string
}

export interface VoucherFull extends PendingVoucher {
  ref_document_number: string | null
  payment_mode: string | null
  bank_ledger_name: string | null
  cheque_number: string | null
  cheque_date: string | null
  utr_number: string | null
  cost_centre_name: string | null
  posted_at: string | null
  posted_by: string | null
  posted_by_name: string | null
  otp_verified_at: string | null
  otp_verified_by: string | null
  otp_verified_by_name: string | null
  completed_at: string | null
  completed_by: string | null
  completed_by_name: string | null
  // Pay Now — entity payment details
  entity_upi_id:       string | null
  entity_bank_account: string | null
  entity_bank_ifsc:    string | null
  entity_bank_name:    string | null
  // Pay Now — voucher paid tracking
  paid_from_account:   string | null
  paid_at:             string | null
  entries: VoucherEntryDetail[]
  history: ApprovalHistoryItem[]
}

// ── Fetch pending count (for sidebar badge) ───────────────────────────────────

export async function fetchPendingCount(companyId: string): Promise<number> {
  // Must mirror the filter in fetchPendingVouchers:
  //   pending_approval  → always shown
  //   approved          → only shown when voucher_type.nature = 'payment' (OTP pending)
  //
  // NOTE: do NOT use .eq('voucher_types.nature', 'payment') on an aliased
  // embedded join — PostgREST applies that as a resource-level column filter,
  // not a WHERE on the parent row, so it counts ALL approved vouchers.
  // Instead resolve payment voucher_type ids first, then filter by FK directly.

  // Step 1: get all voucher_type ids whose nature = 'payment'
  const { data: ptData } = await supabase
    .schema('pramaana')
    .from('voucher_types')
    .select('id')
    .eq('nature', 'payment')
  const paymentTypeIds = (ptData ?? []).map((r: { id: string }) => r.id)

  const [pendingRes, approvedRes] = await Promise.all([
    supabase
      .schema('pramaana')
      .from('vouchers')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('status', 'pending_approval'),
    paymentTypeIds.length > 0
      ? supabase
          .schema('pramaana')
          .from('vouchers')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('status', 'approved')
          .in('voucher_type_id', paymentTypeIds)
      : Promise.resolve({ count: 0 }),
  ])
  return (pendingRes.count ?? 0) + (approvedRes.count ?? 0)
}

// ── Fetch pending vouchers list ───────────────────────────────────────────────

export async function fetchPendingVouchers(companyId: string): Promise<PendingVoucher[]> {
  type RawRow = {
    id: string
    voucher_number: string
    voucher_date: string
    amount: number
    status: string
    narration: string | null
    created_at: string
    entity_id: string | null
    created_by: string
    voucher_type: { id: string; code: string; name: string; nature: string } | null
  }

  const { data, error } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .select('id, voucher_number, voucher_date, amount, status, narration, created_at, entity_id, created_by, voucher_type:voucher_types(id, code, name, nature)')
    .eq('company_id', companyId)
    .in('status', ['pending_approval', 'approved'])
    .order('created_at', { ascending: false })

  if (error) throw new Error('Failed to load pending vouchers: ' + error.message)

  const rows = (data ?? []) as unknown as RawRow[]

  // Batch-fetch profiles + entity names (cross-schema: registry)
  const creatorIds = [...new Set(rows.map(r => r.created_by).filter(Boolean) as string[])]
  const entityIds  = [...new Set(rows.map(r => r.entity_id).filter(Boolean) as string[])]

  const [profilesRes, entitiesRes] = await Promise.all([
    creatorIds.length > 0
      ? supabase.schema('registry').from('profiles').select('id, full_name').in('id', creatorIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
    entityIds.length > 0
      ? supabase.schema('registry').from('entities').select('id, display_name, mobile').in('id', entityIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string; mobile: string | null }[] }),
  ])

  const profileMap = new Map<string, string>(
    ((profilesRes.data ?? []) as { id: string; full_name: string | null }[])
      .map(p => [p.id, p.full_name ?? 'Unknown'])
  )
  const entityMap = new Map<string, string>(
    ((entitiesRes.data ?? []) as { id: string; display_name: string; mobile: string | null }[])
      .map(e => [e.id, e.display_name])
  )
  const entityMobileMap = new Map<string, string | null>(
    ((entitiesRes.data ?? []) as { id: string; display_name: string; mobile: string | null }[])
      .map(e => [e.id, e.mobile ?? null])
  )

  return rows
    // Filter out non-payment vouchers stuck in 'approved' status from old code.
    // Only 'payment' nature vouchers should sit in 'approved' (OTP-pending).
    // All other types now go directly to 'posted' on approval.
    .filter(r =>
      r.status === 'pending_approval' ||
      (r.status === 'approved' && r.voucher_type?.nature === 'payment')
    )
    .map(r => ({
    id: r.id,
    voucher_number: r.voucher_number,
    voucher_date: r.voucher_date,
    amount: r.amount,
    status: r.status,
    narration: r.narration,
    created_at: r.created_at,
    entity_id: r.entity_id,
    created_by: r.created_by,
    voucher_type: r.voucher_type ?? { id: '', code: '?', name: 'Unknown', nature: '' },
    created_by_name: profileMap.get(r.created_by) ?? 'Unknown',
    entity_name:   r.entity_id ? (entityMap.get(r.entity_id) ?? null) : null,
    entity_mobile: r.entity_id ? (entityMobileMap.get(r.entity_id) ?? null) : null,
  }))
}

// ── Fetch full voucher for detail panel ───────────────────────────────────────

export async function fetchVoucherFull(voucherId: string): Promise<VoucherFull> {
  type RawVoucher = {
    id: string; voucher_number: string; voucher_date: string
    amount: number; status: string; narration: string | null
    created_at: string; entity_id: string | null; created_by: string
    ref_document_number: string | null; payment_mode: string | null
    bank_ledger_id: string | null; cheque_number: string | null
    cheque_date: string | null; utr_number: string | null
    cost_centre_id: string | null
    posted_at: string | null; posted_by: string | null
    otp_verified_at: string | null; otp_verified_by: string | null
    completed_at: string | null; completed_by: string | null
    paid_from_account: string | null; paid_at: string | null
    voucher_type: { id: string; code: string; name: string; nature: string } | null
  }
  type RawEntry = {
    id: string; entry_type: 'Dr' | 'Cr'; amount: number
    narration: string | null; sort_order: number
    ledger: { name: string; group: { name: string; nature: string } | null } | null
  }
  type RawAction = {
    id: string; action: string; actioned_by: string
    comments: string | null; actioned_at: string
  }

  // Batch 1: three main queries in parallel
  const [vRes, eRes, hRes] = await Promise.all([
    supabase
      .schema('pramaana').from('vouchers')
      .select('id, voucher_number, voucher_date, amount, status, narration, created_at, entity_id, created_by, ref_document_number, payment_mode, bank_ledger_id, cheque_number, cheque_date, utr_number, cost_centre_id, posted_at, posted_by, otp_verified_at, otp_verified_by, completed_at, completed_by, paid_from_account, paid_at, voucher_type:voucher_types(id, code, name, nature)')
      .eq('id', voucherId)
      .single(),
    supabase
      .schema('pramaana').from('voucher_entries')
      .select('id, entry_type, amount, narration, sort_order, ledger:ledgers(name, group:ledger_groups(name, nature))')
      .eq('voucher_id', voucherId)
      .order('sort_order'),
    supabase
      .schema('pramaana').from('approval_actions')
      .select('id, action, actioned_by, comments, actioned_at')
      .eq('voucher_id', voucherId)
      .order('actioned_at', { ascending: true }),
  ])

  if (vRes.error) throw new Error('Failed to load voucher: ' + vRes.error.message)

  const v       = vRes.data as unknown as RawVoucher
  const entries = (eRes.data ?? []) as unknown as RawEntry[]
  const actions = (hRes.data ?? []) as unknown as RawAction[]

  // Batch 2: profiles + optional lookups in parallel
  const profileIds = [...new Set([
    v.created_by,
    v.posted_by,
    v.otp_verified_by,
    v.completed_by,
    ...actions.map(a => a.actioned_by),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0))]

  const [profilesRes, entityRes, bankRes, costRes] = await Promise.all([
    supabase.schema('registry').from('profiles').select('id, full_name').in('id', profileIds),
    v.entity_id
      ? supabase.schema('registry').from('entities').select('id, display_name, mobile, upi_id, bank_name, bank_account_number, bank_ifsc').eq('id', v.entity_id).maybeSingle()
      : Promise.resolve(null),
    v.bank_ledger_id
      ? supabase.schema('pramaana').from('ledgers').select('id, name').eq('id', v.bank_ledger_id).maybeSingle()
      : Promise.resolve(null),
    v.cost_centre_id
      ? supabase.schema('pramaana').from('cost_centres').select('id, name').eq('id', v.cost_centre_id).maybeSingle()
      : Promise.resolve(null),
  ])

  const profileMap = new Map<string, string>(
    ((profilesRes.data ?? []) as { id: string; full_name: string | null }[])
      .map(p => [p.id, p.full_name ?? 'Unknown'])
  )

  const entityData   = entityRes   ? (entityRes   as { data: { display_name: string; mobile: string | null; upi_id: string | null; bank_name: string | null; bank_account_number: string | null; bank_ifsc: string | null } | null }).data : null
  const bankData     = bankRes     ? (bankRes     as { data: { name: string }           | null }).data : null
  const costData     = costRes     ? (costRes     as { data: { name: string }           | null }).data : null

  return {
    id: v.id,
    voucher_number: v.voucher_number,
    voucher_date: v.voucher_date,
    amount: v.amount,
    status: v.status,
    narration: v.narration,
    created_at: v.created_at,
    entity_id: v.entity_id,
    created_by: v.created_by,
    voucher_type: v.voucher_type ?? { id: '', code: '?', name: 'Unknown', nature: '' },
    created_by_name: profileMap.get(v.created_by) ?? 'Unknown',
    entity_name:         entityData ? entityData.display_name : null,
    entity_mobile:       entityData ? (entityData.mobile ?? null) : null,
    entity_upi_id:       entityData ? (entityData.upi_id ?? null) : null,
    entity_bank_account: entityData ? (entityData.bank_account_number ?? null) : null,
    entity_bank_ifsc:    entityData ? (entityData.bank_ifsc ?? null) : null,
    entity_bank_name:    entityData ? (entityData.bank_name ?? null) : null,
    paid_from_account:   v.paid_from_account,
    paid_at:             v.paid_at,
    ref_document_number: v.ref_document_number,
    payment_mode:        v.payment_mode,
    bank_ledger_name:    bankData   ? bankData.name   : null,
    cheque_number:       v.cheque_number,
    cheque_date:         v.cheque_date,
    utr_number:          v.utr_number,
    cost_centre_name:    costData   ? costData.name   : null,
    posted_at:           v.posted_at,
    posted_by:           v.posted_by,
    posted_by_name:      v.posted_by ? (profileMap.get(v.posted_by) ?? null) : null,
    otp_verified_at:     v.otp_verified_at,
    otp_verified_by:     v.otp_verified_by,
    otp_verified_by_name:v.otp_verified_by ? (profileMap.get(v.otp_verified_by) ?? null) : null,
    completed_at:        v.completed_at,
    completed_by:        v.completed_by,
    completed_by_name:   v.completed_by ? (profileMap.get(v.completed_by) ?? null) : null,
    entries: entries.map(e => ({
      id:           e.id,
      ledger_name:  e.ledger?.name ?? '—',
      group_name:   e.ledger?.group?.name   ?? null,
      group_nature: e.ledger?.group?.nature ?? null,
      entry_type:   e.entry_type,
      amount:       e.amount,
      narration:    e.narration,
      sort_order:   e.sort_order,
    })),
    history: actions.map(a => ({
      id:                 a.id,
      action:             a.action as ApprovalHistoryItem['action'],
      actioned_by_name:   profileMap.get(a.actioned_by) ?? 'Unknown',
      comments:           a.comments,
      actioned_at:        a.actioned_at,
    })),
  }
}

// ── Approve voucher result type ───────────────────────────────────────────────

export interface ApproveVoucherResult {
  approved:     boolean
  otp_sent:     boolean
  mobile_masked: string | null
  otp_reason?:  string
}

// ── Approve voucher ───────────────────────────────────────────────────────────
// Transitions: pending_approval → approved
// Then initiates OTP send to the payee's registered mobile.
// The voucher stays in 'approved' until the OTP is verified, at which
// point verifyPaymentOtp() advances it to 'completed'.
// (Previously this set status='posted' directly — moved to a two-step flow.)

// ── Approve voucher ───────────────────────────────────────────────────────────
// OTP is ONLY initiated for 'payment' nature vouchers (outward payments to
// domestic payees). All other voucher types (sales, purchase, receipt,
// journal, contra) are posted immediately on admin approval — no OTP step.
// Rationale: OTP verifies "you are the correct recipient of funds being sent."
// For sales/receipts the money is coming IN; for journals there is no cash
// movement. Sending OTP to a foreign export customer is not feasible.

export async function approveVoucher(
  voucherId:     string,
  companyId:     string,
  userId:        string,
  comments:      string | null,
  entityId:      string | null,
  voucherNature: string,        // e.g. 'payment' | 'sales' | 'purchase' | ...
): Promise<ApproveVoucherResult> {
  const now = new Date().toISOString()
  const isPayment = voucherNature === 'payment'

  // Step 1 — Advance status:
  //   payment  → 'approved'  (OTP verification pending)
  //   all else → 'posted'    (final state; no OTP or Pay Now step needed)
  const newStatus = isPayment ? 'approved' : 'posted'

  const { error: vErr } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update({ status: newStatus, posted_at: now, posted_by: userId })
    .eq('id', voucherId)
    .eq('status', 'pending_approval')

  if (vErr) throw new Error('Failed to approve voucher: ' + vErr.message)

  // Step 2 — Record approval action
  const { error: aErr } = await supabase
    .schema('pramaana')
    .from('approval_actions')
    .insert({
      voucher_id:   voucherId,
      company_id:   companyId,
      action:       'approved',
      actioned_by:  userId,
      comments:     comments || null,
      actioned_at:  now,
    })

  if (aErr) throw new Error('Failed to record approval: ' + aErr.message)

  // Step 3 — OTP only for outward payment vouchers
  if (!isPayment) {
    return { approved: true, otp_sent: false, mobile_masked: null, otp_reason: 'not_applicable' }
  }

  // Step 3 — Initiate OTP for payee (payment vouchers only)
  const otpResult: OtpInitResult = await initiatePaymentOtp(
    voucherId, companyId, userId, entityId
  )

  return {
    approved:      true,
    otp_sent:      otpResult.sent,
    mobile_masked: otpResult.sent ? otpResult.mobile_masked : null,
    otp_reason:    otpResult.sent ? undefined : ('reason' in otpResult ? otpResult.reason : undefined),
  }
}

// ── Reject voucher ────────────────────────────────────────────────────────────

export async function rejectVoucher(
  voucherId: string,
  companyId: string,
  userId: string,
  reason: string,
): Promise<void> {
  const { error: vErr } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update({ status: 'draft' })
    .eq('id', voucherId)

  if (vErr) throw new Error('Failed to reject voucher: ' + vErr.message)

  const { error: aErr } = await supabase
    .schema('pramaana')
    .from('approval_actions')
    .insert({
      voucher_id:   voucherId,
      company_id:   companyId,
      action:       'rejected',
      actioned_by:  userId,
      comments:     reason,
      actioned_at:  new Date().toISOString(),
    })

  if (aErr) throw new Error('Failed to record rejection: ' + aErr.message)
}
