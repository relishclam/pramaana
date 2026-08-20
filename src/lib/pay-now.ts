import { supabase } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CompanyPaymentAccount {
  id:                  string
  company_id:          string
  label:               string
  account_holder_name: string | null
  bank_name:           string | null
  bank_account_number: string | null
  bank_ifsc:           string | null
  upi_id:              string | null
  is_primary:          boolean
  is_active:           boolean
  created_at:          string
}

export interface MarkPaidPayload {
  userId:            string          // auth user who marked it paid (→ paid_by audit trail)
  paid_from_account: string | null
  paid_at:           string          // ISO timestamp
  utr_number:        string | null   // for UPI / NEFT / RTGS / IMPS / Bank modes
  cheque_number:     string | null   // for Cheque mode only
}

// ── Company payment accounts — reads from registry.company_bank_accounts ─────

export async function fetchCompanyPaymentAccounts(
  companyId: string,
): Promise<CompanyPaymentAccount[]> {
  const { data, error } = await supabase
    .schema('registry')
    .from('company_bank_accounts')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })

  if (error) throw new Error('Failed to load payment accounts: ' + error.message)
  return (data ?? []) as CompanyPaymentAccount[]
}

export async function addCompanyPaymentAccount(
  companyId: string,
  label:     string,
): Promise<CompanyPaymentAccount> {
  const trimmed = label.trim()
  if (!trimmed) throw new Error('Account label is required')

  const { data, error } = await supabase
    .schema('registry')
    .from('company_bank_accounts')
    .insert({ company_id: companyId, label: trimmed })
    .select()
    .single()

  if (error) throw new Error('Failed to add payment account: ' + error.message)
  return data as CompanyPaymentAccount
}

export async function deleteCompanyPaymentAccount(id: string): Promise<void> {
  // Soft-delete to preserve referential integrity with vouchers that reference this account
  const { error } = await supabase
    .schema('registry')
    .from('company_bank_accounts')
    .update({ is_active: false })
    .eq('id', id)

  if (error) throw new Error('Failed to delete payment account: ' + error.message)
}

// ── Mark voucher paid ─────────────────────────────────────────────────────────

export async function markVoucherPaid(
  voucherId: string,
  payload:   MarkPaidPayload,
): Promise<void> {
  const update: Record<string, unknown> = {
    // Transition to final accounting state — required for financial reports
    // (Trial Balance, P&L, Balance Sheet all filter status = 'posted')
    status:            'posted',
    paid_at:           payload.paid_at,
    paid_by:           payload.userId,    // audit trail: who recorded the payment
    paid_from_account: payload.paid_from_account,
  }
  if (payload.utr_number?.trim())    update['utr_number']    = payload.utr_number.trim()
  if (payload.cheque_number?.trim()) update['cheque_number'] = payload.cheque_number.trim()

  // TODO: auto-populate paid_at, utr_number, paid_from_account from recon_matches when confirmed
  const { error, count } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update(update, { count: 'exact' })
    .eq('id', voucherId)
    .in('status', ['approved', 'completed', 'awaiting_payment'])

  if (error) throw new Error('Failed to mark voucher as paid: ' + error.message)
  if (!count) throw new Error('Voucher is not in a payable state (may already be posted)')
}

// ── Queue voucher for payment (→ awaiting_payment) ───────────────────────────────

export async function queueForPayment(
  voucherId: string,
  userId:    string,
): Promise<void> {
  const { error, count } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update({
      status:                 'awaiting_payment',
      queued_at:              new Date().toISOString(),
      queued_for_payment_by:  userId,
    }, { count: 'exact' })
    .eq('id', voucherId)
    .eq('status', 'completed')

  if (error) throw new Error('Failed to queue voucher: ' + error.message)
  if (!count) throw new Error('Voucher is not in completed state')
}

// ── Dequeue voucher (defer payment → back to completed) ──────────────────────

export async function dequeuePayment(voucherId: string): Promise<void> {
  const { error, count } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update({
      status:                'completed',
      queued_at:             null,
      queued_for_payment_by: null,
    }, { count: 'exact' })
    .eq('id', voucherId)
    .eq('status', 'awaiting_payment')

  if (error) throw new Error('Failed to dequeue voucher: ' + error.message)
  if (!count) throw new Error('Voucher is not in awaiting_payment state')
}

// ── Set payment mode on an existing voucher (inline fix for queued vouchers) ──

export async function updateVoucherPaymentMode(
  voucherId: string,
  paymentMode: string,
): Promise<void> {
  const { error } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update({ payment_mode: paymentMode.toLowerCase() })
    .eq('id', voucherId)
    .in('status', ['completed', 'awaiting_payment'])  // prevent updating posted vouchers

  if (error) throw new Error('Failed to update payment mode: ' + error.message)
}

// ── Fetch Admin mobile for WhatsApp notification ──────────────────────────────
//
// Fallback chain (stops at first non-null result):
//   1. registry.profiles.mobile        — directly set on the admin’s profile
//   2. registry.entities.mobile        — via profiles.entity_id (profile linked to an entity)
//   3. registry.entity_roles + entities — entity with role = 'Management' for this company
//
// The schema already has profiles.mobile + profiles.entity_id; they just need populating.
// Phase 1: set profiles.mobile in AdminPanel → Users.
// Phase 2: link profiles.entity_id → entities to auto-sync.

export async function fetchAdminMobile(companyId: string): Promise<string | null> {
  // ─ find admin user IDs for this company ─────────────────────────────
  const { data: admins } = await supabase
    .schema('registry')
    .from('company_users')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('role', 'admin')

  const adminIds = (admins as { user_id: string }[] | null)?.map(a => a.user_id) ?? []

  if (adminIds.length) {
    // ─ 1. profiles.mobile ─────────────────────────────────────────────────
    const { data: profile } = await supabase
      .schema('registry')
      .from('profiles')
      .select('mobile, entity_id')
      .in('id', adminIds)
      .not('mobile', 'is', null)
      .limit(1)
      .maybeSingle()

    const profileRow = profile as { mobile: string | null; entity_id: string | null } | null
    if (profileRow?.mobile) return profileRow.mobile

    // ─ 2. profiles.entity_id → entities.mobile ──────────────────────────
    const { data: linkedProfile } = await supabase
      .schema('registry')
      .from('profiles')
      .select('entity_id')
      .in('id', adminIds)
      .not('entity_id', 'is', null)
      .limit(1)
      .maybeSingle()

    const entityId = (linkedProfile as { entity_id: string | null } | null)?.entity_id
    if (entityId) {
      const { data: entity } = await supabase
        .schema('registry')
        .from('entities')
        .select('mobile')
        .eq('id', entityId)
        .not('mobile', 'is', null)
        .maybeSingle()

      const mob = (entity as { mobile: string | null } | null)?.mobile
      if (mob) return mob
    }
  }

  // ─ 3. Management entity role for this company ───────────────────────
  // Reaches here when there is no admin profile OR no mobile/entity_id on the profile.
  // Falls back to the first active Management entity for this company.
  const { data: mgmtRoles } = await supabase
    .schema('registry')
    .from('entity_roles')
    .select('entity_id')
    .eq('company_id', companyId)
    .eq('role', 'Management')
    .eq('is_active', true)
    .limit(5)

  const mgmtEntityIds = (mgmtRoles as { entity_id: string }[] | null)?.map(r => r.entity_id) ?? []

  if (mgmtEntityIds.length) {
    const { data: mgmtEntity } = await supabase
      .schema('registry')
      .from('entities')
      .select('mobile')
      .in('id', mgmtEntityIds)
      .not('mobile', 'is', null)
      .limit(1)
      .maybeSingle()

    const mob = (mgmtEntity as { mobile: string | null } | null)?.mobile
    if (mob) return mob
  }

  // Step 4: public.profiles.phone (Relish Suite shared auth.users UUID)
  // Most reliable fallback until registry.profiles.mobile is seeded.
  if (adminIds.length) {
    const { data: pubProfile } = await supabase
      .from('profiles')          // no .schema() -> defaults to public
      .select('phone')
      .in('id', adminIds)
      .not('phone', 'is', null)
      .limit(1)
      .maybeSingle()

    const pubPhone = (pubProfile as { phone: string | null } | null)?.phone
    if (pubPhone) return pubPhone
  }

  return null
}

// ── Awaiting payment list ─────────────────────────────────────────────────────

export interface AwaitingPaymentRow {
  id:               string
  voucher_number:   string
  voucher_date:     string
  amount:           number
  payment_mode:     string | null
  entity_id:        string | null
  entity_name:      string | null
  completed_at:     string | null
  queued_at:        string | null
  paid_at:          string | null
  paid_from_account: string | null
  voucher_type_code: string
}

export async function fetchAwaitingPaymentsCount(companyId: string): Promise<number> {
  const { count, error } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'awaiting_payment')
  if (error) return 0
  return count ?? 0
}

export async function fetchAwaitingPayments(
  companyId: string,
): Promise<AwaitingPaymentRow[]> {
  type RawRow = {
    id: string
    voucher_number: string
    voucher_date: string
    amount: number
    payment_mode: string | null
    entity_id: string | null
    completed_at: string | null
    queued_at: string | null
    paid_at: string | null
    paid_from_account: string | null
    voucher_type: { code: string } | null
  }

  const { data, error } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .select('id, voucher_number, voucher_date, amount, payment_mode, entity_id, completed_at, queued_at, paid_at, paid_from_account, voucher_type:voucher_types(code)')
    .eq('company_id', companyId)
    .eq('status', 'awaiting_payment')
    .order('queued_at', { ascending: true })

  if (error) throw new Error('Failed to load awaiting payments: ' + error.message)

  const rows = (data ?? []) as unknown as RawRow[]
  const entityIds = [...new Set(rows.map(r => r.entity_id).filter(Boolean) as string[])]

  const entityRes = entityIds.length > 0
    ? await supabase.schema('registry').from('entities').select('id, display_name').in('id', entityIds)
    : { data: [] as { id: string; display_name: string }[] }

  const entityMap = new Map<string, string>(
    ((entityRes.data ?? []) as { id: string; display_name: string }[])
      .map(e => [e.id, e.display_name])
  )

  return rows.map(r => ({
    id:                r.id,
    voucher_number:    r.voucher_number,
    voucher_date:      r.voucher_date,
    amount:            r.amount,
    payment_mode:      r.payment_mode,
    entity_id:         r.entity_id,
    entity_name:       r.entity_id ? (entityMap.get(r.entity_id) ?? null) : null,
    completed_at:      r.completed_at,
    queued_at:         r.queued_at,
    paid_at:           r.paid_at,
    paid_from_account: r.paid_from_account,
    voucher_type_code: r.voucher_type?.code ?? '?',
  }))
}
