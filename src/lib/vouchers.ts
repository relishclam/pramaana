import { supabase } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VoucherType {
  id: string
  code: string
  name: string
  prefix: string
  nature: 'payment' | 'receipt' | 'journal' | 'contra' | 'purchase' | 'sales'
  affects_bank: boolean
  is_active: boolean
}

export interface VoucherEntryRow {
  ledger_id: string
  ledger_name: string       // display only — not sent to DB
  entry_type: 'Dr' | 'Cr'
  amount: string            // string for input control; parsed on submit
  narration: string
}

export interface VoucherPayload {
  company_id: string
  voucher_type_id: string
  voucher_number: string
  voucher_date: string            // ISO date
  narration: string | null
  entity_id: string | null
  amount: number                  // total Dr side (= total Cr side)
  payment_mode: string | null
  bank_ledger_id: string | null
  cheque_number: string | null
  cheque_date: string | null
  utr_number: string | null
  cost_centre_id: string | null
  ref_document_number: string | null
  status: 'draft' | 'pending_approval'
  created_by: string
}

export interface VoucherEntryPayload {
  voucher_id: string
  ledger_id: string
  entry_type: 'Dr' | 'Cr'
  amount: number
  narration: string | null
  sort_order: number
}

// ── Fetch voucher types ───────────────────────────────────────────────────────

export async function fetchVoucherTypes(): Promise<VoucherType[]> {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('voucher_types')
    .select('*')
    .eq('is_active', true)
    .order('name')

  if (error) throw new Error('Failed to load voucher types: ' + error.message)
  return (data ?? []) as VoucherType[]
}

// ── Fetch cost centres for a company ─────────────────────────────────────────

export async function fetchCostCentres(companyId: string) {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('cost_centres')
    .select('id, name, code')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('name')

  if (error) throw new Error('Failed to load cost centres: ' + error.message)
  return (data ?? []) as { id: string; name: string; code: string }[]
}

// ── Fetch bank ledgers for a company ─────────────────────────────────────────

export async function fetchBankLedgers(companyId: string) {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('ledgers')
    .select('id, name, bank_name, account_number')
    .eq('company_id', companyId)
    .eq('is_bank_account', true)
    .eq('is_active', true)
    .order('name')

  if (error) throw new Error('Failed to load bank ledgers: ' + error.message)
  return (data ?? []) as { id: string; name: string; bank_name: string | null; account_number: string | null }[]
}

// ── Fetch payment accounts (bank + cash) for simplified payment entry ─────────

export interface PaymentAccount {
  id: string
  name: string
  type: 'cash' | 'bank'
  account_number: string | null
  bank_name: string | null
}

export async function fetchPaymentAccounts(companyId: string): Promise<PaymentAccount[]> {
  // Fetch bank accounts AND any ledger with "cash" in the name (covers Cash, Petty Cash, etc.)
  const { data, error } = await supabase
    .schema('pramaana')
    .from('ledgers')
    .select('id, name, is_bank_account, bank_name, account_number')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .or('is_bank_account.eq.true,name.ilike.%cash%')
    .order('name')

  if (error) throw new Error('Failed to load payment accounts: ' + error.message)

  return (data ?? []).map((d: {
    id: string
    name: string
    is_bank_account: boolean
    bank_name: string | null
    account_number: string | null
  }) => ({
    id:             d.id,
    name:           d.name,
    type:           d.is_bank_account ? 'bank' : 'cash',
    account_number: d.account_number,
    bank_name:      d.bank_name,
  })) as PaymentAccount[]
}

// ── Fetch ledgers for entry rows (typeahead) ──────────────────────────────────

export async function searchLedgers(companyId: string, query: string) {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('ledgers')
    .select('id, name, group:ledger_groups(nature)')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .ilike('name', `%${query}%`)
    .limit(12)

  if (error) throw new Error('Failed to search ledgers: ' + error.message)
  return (data ?? []) as unknown as { id: string; name: string; group: { nature: string } | null }[]
}

// ── Get next FY sequence number ───────────────────────────────────────────────

export async function getNextSequence(
  companyId: string,
  companyCode: string,
  prefix: string,
): Promise<string> {
  const { data, error } = await supabase
    .schema('registry')
    .rpc('next_fy_sequence', {
      p_company_id:   companyId,
      p_company_code: companyCode,
      p_prefix:       prefix,
    })

  if (error) throw new Error('Failed to generate voucher number: ' + error.message)
  return data as string
}

// ── Save draft voucher ────────────────────────────────────────────────────────

export async function saveDraftVoucher(
  payload: VoucherPayload,
  entries: VoucherEntryPayload[],
): Promise<string> {
  // Insert voucher
  const { data: voucher, error: vErr } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .insert(payload)
    .select('id')
    .single()

  if (vErr) throw new Error('Failed to save voucher: ' + vErr.message)
  const voucherId = (voucher as { id: string }).id

  // Insert entries
  const entryRows = entries.map(e => ({ ...e, voucher_id: voucherId }))
  const { error: eErr } = await supabase
    .schema('pramaana')
    .from('voucher_entries')
    .insert(entryRows)

  if (eErr) throw new Error('Failed to save voucher entries: ' + eErr.message)

  return voucherId
}

// ── Submit for approval (generates voucher number) ───────────────────────────

export async function submitVoucher(
  payload: Omit<VoucherPayload, 'voucher_number' | 'status'>,
  entries: Omit<VoucherEntryPayload, 'voucher_id'>[],
  companyCode: string,
  prefix: string,
): Promise<string> {
  // Step 1: get sequence number
  const voucherNumber = await getNextSequence(payload.company_id, companyCode, prefix)

  // Step 2: insert voucher with number + pending_approval status
  const fullPayload: VoucherPayload = {
    ...payload,
    voucher_number: voucherNumber,
    status: 'pending_approval',
  }

  return saveDraftVoucher(
    fullPayload,
    entries.map((e, i) => ({ ...e, voucher_id: '', sort_order: i })),
  )
}

// ── Load a draft voucher for editing ─────────────────────────────────────────

export interface VoucherForEdit {
  id: string
  voucher_number: string
  voucher_date: string
  narration: string | null
  entity_id: string | null
  payment_mode: string | null
  bank_ledger_id: string | null
  cheque_number: string | null
  cheque_date: string | null
  utr_number: string | null
  cost_centre_id: string | null
  ref_document_number: string | null
  status: string
  voucher_type: { id: string; code: string; name: string; nature: string; prefix: string }
  entries: { id: string; ledger_id: string; ledger_name: string; entry_type: 'Dr' | 'Cr'; amount: number; narration: string | null; sort_order: number }[]
}

export async function fetchVoucherForEdit(voucherId: string): Promise<VoucherForEdit> {
  const [vRes, eRes] = await Promise.all([
    supabase
      .schema('pramaana')
      .from('vouchers')
      .select('id, voucher_number, voucher_date, narration, entity_id, payment_mode, bank_ledger_id, cheque_number, cheque_date, utr_number, cost_centre_id, ref_document_number, status, voucher_type:voucher_types(id, code, name, nature, prefix)')
      .eq('id', voucherId)
      .single(),
    supabase
      .schema('pramaana')
      .from('voucher_entries')
      .select('id, ledger_id, entry_type, amount, narration, sort_order, ledger:ledgers(name)')
      .eq('voucher_id', voucherId)
      .order('sort_order'),
  ])

  if (vRes.error) throw new Error('Failed to load voucher: ' + vRes.error.message)

  type RawV = {
    id: string; voucher_number: string; voucher_date: string
    narration: string | null; entity_id: string | null
    payment_mode: string | null; bank_ledger_id: string | null
    cheque_number: string | null; cheque_date: string | null
    utr_number: string | null; cost_centre_id: string | null
    ref_document_number: string | null; status: string
    voucher_type: { id: string; code: string; name: string; nature: string; prefix: string } | null
  }
  type RawE = {
    id: string; ledger_id: string; entry_type: 'Dr' | 'Cr'; amount: number
    narration: string | null; sort_order: number
    ledger: { name: string } | null
  }

  const v = vRes.data as unknown as RawV
  const entries = (eRes.data ?? []) as unknown as RawE[]

  return {
    id: v.id,
    voucher_number: v.voucher_number,
    voucher_date: v.voucher_date,
    narration: v.narration,
    entity_id: v.entity_id,
    payment_mode: v.payment_mode,
    bank_ledger_id: v.bank_ledger_id,
    cheque_number: v.cheque_number,
    cheque_date: v.cheque_date,
    utr_number: v.utr_number,
    cost_centre_id: v.cost_centre_id,
    ref_document_number: v.ref_document_number,
    status: v.status,
    voucher_type: v.voucher_type ?? { id: '', code: '?', name: 'Unknown', nature: '', prefix: '' },
    entries: entries.map(e => ({
      id: e.id,
      ledger_id: e.ledger_id,
      ledger_name: e.ledger?.name ?? '—',
      entry_type: e.entry_type,
      amount: e.amount,
      narration: e.narration,
      sort_order: e.sort_order,
    })),
  }
}

// ── Update an existing draft voucher (delete + reinsert entries) ──────────────

export async function updateDraftVoucher(
  voucherId: string,
  update: Partial<Omit<VoucherPayload, 'company_id' | 'created_by'>>,
  entries: Omit<VoucherEntryPayload, 'voucher_id'>[],
): Promise<void> {
  // Update voucher header
  const { error: vErr } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update(update)
    .eq('id', voucherId)

  if (vErr) throw new Error('Failed to update voucher: ' + vErr.message)

  // Delete existing entries then reinsert
  const { error: dErr } = await supabase
    .schema('pramaana')
    .from('voucher_entries')
    .delete()
    .eq('voucher_id', voucherId)

  if (dErr) throw new Error('Failed to clear entries: ' + dErr.message)

  const entryRows = entries.map(e => ({ ...e, voucher_id: voucherId }))
  const { error: eErr } = await supabase
    .schema('pramaana')
    .from('voucher_entries')
    .insert(entryRows)

  if (eErr) throw new Error('Failed to save updated entries: ' + eErr.message)
}

// ── Indian number formatting ──────────────────────────────────────────────────

export function formatIndianCurrency(amount: number): string {
  if (isNaN(amount)) return '₹0.00'
  return '₹' + amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
