import { supabase } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CompanyPaymentAccount {
  id:         string
  company_id: string
  label:      string
  created_at: string
}

export interface MarkPaidPayload {
  paid_from_account: string | null
  paid_at:           string          // ISO timestamp
  utr_number:        string | null
}

// ── Company payment accounts ──────────────────────────────────────────────────

export async function fetchCompanyPaymentAccounts(
  companyId: string,
): Promise<CompanyPaymentAccount[]> {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('company_payment_accounts')
    .select('*')
    .eq('company_id', companyId)
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
    .schema('pramaana')
    .from('company_payment_accounts')
    .insert({ company_id: companyId, label: trimmed })
    .select()
    .single()

  if (error) throw new Error('Failed to add payment account: ' + error.message)
  return data as CompanyPaymentAccount
}

export async function deleteCompanyPaymentAccount(id: string): Promise<void> {
  const { error } = await supabase
    .schema('pramaana')
    .from('company_payment_accounts')
    .delete()
    .eq('id', id)

  if (error) throw new Error('Failed to delete payment account: ' + error.message)
}

// ── Mark voucher paid ─────────────────────────────────────────────────────────

export async function markVoucherPaid(
  voucherId: string,
  payload:   MarkPaidPayload,
): Promise<void> {
  const update: Record<string, unknown> = {
    paid_at:           payload.paid_at,
    paid_from_account: payload.paid_from_account,
  }
  if (payload.utr_number?.trim()) {
    update['utr_number'] = payload.utr_number.trim()
  }

  const { error } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update(update)
    .eq('id', voucherId)
    .eq('status', 'completed')

  if (error) throw new Error('Failed to mark voucher as paid: ' + error.message)
}

// ── Awaiting payment list ─────────────────────────────────────────────────────

export interface AwaitingPaymentRow {
  id:               string
  voucher_number:   string
  voucher_date:     string
  amount:           number
  payment_mode:     string | null
  entity_name:      string | null
  completed_at:     string | null
  paid_at:          string | null
  paid_from_account: string | null
  voucher_type_code: string
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
    paid_at: string | null
    paid_from_account: string | null
    voucher_type: { code: string } | null
  }

  const { data, error } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .select('id, voucher_number, voucher_date, amount, payment_mode, entity_id, completed_at, paid_at, paid_from_account, voucher_type:voucher_types(code)')
    .eq('company_id', companyId)
    .eq('status', 'completed')
    .neq('payment_mode', 'Cash')
    .is('paid_at', null)
    .order('completed_at', { ascending: true })

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
    entity_name:       r.entity_id ? (entityMap.get(r.entity_id) ?? null) : null,
    completed_at:      r.completed_at,
    paid_at:           r.paid_at,
    paid_from_account: r.paid_from_account,
    voucher_type_code: r.voucher_type?.code ?? '?',
  }))
}
