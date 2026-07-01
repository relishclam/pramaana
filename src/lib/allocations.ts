import { supabase } from './supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OpenBill {
  id:                   string
  voucher_number:       string
  voucher_date:         string
  amount:               number
  outstanding:          number   // amount minus already-allocated
  narration:            string | null
  ref_document_number:  string | null
}

export interface AllocRow {
  bill_voucher_id:  string
  amount_allocated: number
}

export interface AllocationDetail {
  bill_voucher_id:     string
  bill_voucher_number: string
  bill_voucher_date:   string
  bill_amount:         number
  amount_allocated:    number
}

export interface BillPaymentDetail {
  payment_voucher_id:     string
  payment_voucher_number: string
  payment_voucher_date:   string
  amount_allocated:       number
}

export interface BillSummary extends OpenBill {
  entity_id:   string | null
  entity_name: string | null
}

// ── Open bills for a specific entity (for bill allocation step in SPE) ────────

export async function fetchOpenBills(
  companyId:  string,
  entityId:   string,
  billNature: 'purchase' | 'sales',
): Promise<OpenBill[]> {
  const { data: vt } = await supabase
    .schema('pramaana').from('voucher_types')
    .select('id').eq('nature', billNature)
  const typeIds = ((vt ?? []) as { id: string }[]).map(t => t.id)
  if (!typeIds.length) return []

  type RawVoucher = {
    id: string; voucher_number: string; voucher_date: string
    amount: number; narration: string | null; ref_document_number: string | null
  }

  const { data: vouchers, error } = await supabase
    .schema('pramaana').from('vouchers')
    .select('id, voucher_number, voucher_date, amount, narration, ref_document_number')
    .eq('company_id', companyId)
    .eq('entity_id', entityId)
    .in('voucher_type_id', typeIds)
    .in('status', ['approved', 'completed', 'awaiting_payment', 'posted'])
    .order('voucher_date', { ascending: true })
  if (error) throw new Error(error.message)
  if (!vouchers?.length) return []

  const voucherIds = (vouchers as RawVoucher[]).map(v => v.id)

  const { data: allocs } = await supabase
    .schema('pramaana').from('voucher_allocations')
    .select('bill_voucher_id, amount_allocated')
    .in('bill_voucher_id', voucherIds)

  const allocMap = new Map<string, number>()
  for (const a of (allocs ?? []) as { bill_voucher_id: string; amount_allocated: number }[])
    allocMap.set(a.bill_voucher_id, (allocMap.get(a.bill_voucher_id) ?? 0) + a.amount_allocated)

  return (vouchers as RawVoucher[])
    .map(v => ({
      id:                  v.id,
      voucher_number:      v.voucher_number,
      voucher_date:        v.voucher_date,
      amount:              v.amount,
      outstanding:         Math.max(0, v.amount - (allocMap.get(v.id) ?? 0)),
      narration:           v.narration,
      ref_document_number: v.ref_document_number,
    }))
    .filter(v => v.outstanding > 0.005)
}

// ── Save allocations (called after voucher is created) ────────────────────────

export async function saveAllocations(
  companyId:         string,
  entityId:          string | null,
  paymentVoucherId:  string,
  allocatedBy:       string,
  rows:              AllocRow[],
): Promise<void> {
  if (!rows.length) return
  const { error } = await supabase
    .schema('pramaana').from('voucher_allocations')
    .insert(rows.map(r => ({
      company_id:         companyId,
      entity_id:          entityId,
      bill_voucher_id:    r.bill_voucher_id,
      payment_voucher_id: paymentVoucherId,
      amount_allocated:   r.amount_allocated,
      is_advance:         false,
      allocated_by:       allocatedBy,
    })))
  if (error) throw new Error('Failed to save bill allocations: ' + error.message)
}

// ── For the Payment/Receipt detail panel: which bills did this payment settle? ─

export async function fetchAllocationsForPayment(
  paymentVoucherId: string,
): Promise<AllocationDetail[]> {
  const { data, error } = await supabase
    .schema('pramaana').from('voucher_allocations')
    .select('bill_voucher_id, amount_allocated')
    .eq('payment_voucher_id', paymentVoucherId)
  if (error) throw new Error(error.message)
  if (!data?.length) return []

  const billIds = (data as { bill_voucher_id: string }[]).map(a => a.bill_voucher_id)
  const { data: bills } = await supabase
    .schema('pramaana').from('vouchers')
    .select('id, voucher_number, voucher_date, amount')
    .in('id', billIds)

  type RawBill = { id: string; voucher_number: string; voucher_date: string; amount: number }
  const billMap = new Map<string, RawBill>()
  for (const b of (bills ?? []) as RawBill[]) billMap.set(b.id, b)

  return (data as { bill_voucher_id: string; amount_allocated: number }[]).map(a => {
    const b = billMap.get(a.bill_voucher_id)
    return {
      bill_voucher_id:     a.bill_voucher_id,
      bill_voucher_number: b?.voucher_number ?? '—',
      bill_voucher_date:   b?.voucher_date   ?? '—',
      bill_amount:         b?.amount         ?? 0,
      amount_allocated:    a.amount_allocated,
    }
  })
}

// ── For the Purchase/Sales bill detail panel: which payments were applied? ─────

export async function fetchAllocationsForBill(
  billVoucherId: string,
): Promise<BillPaymentDetail[]> {
  const { data, error } = await supabase
    .schema('pramaana').from('voucher_allocations')
    .select('payment_voucher_id, amount_allocated')
    .eq('bill_voucher_id', billVoucherId)
  if (error) throw new Error(error.message)
  if (!data?.length) return []

  const payIds = (data as { payment_voucher_id: string }[]).map(a => a.payment_voucher_id)
  const { data: pays } = await supabase
    .schema('pramaana').from('vouchers')
    .select('id, voucher_number, voucher_date')
    .in('id', payIds)

  type RawPay = { id: string; voucher_number: string; voucher_date: string }
  const payMap = new Map<string, RawPay>()
  for (const p of (pays ?? []) as RawPay[]) payMap.set(p.id, p)

  return (data as { payment_voucher_id: string; amount_allocated: number }[]).map(a => {
    const p = payMap.get(a.payment_voucher_id)
    return {
      payment_voucher_id:     a.payment_voucher_id,
      payment_voucher_number: p?.voucher_number ?? '—',
      payment_voucher_date:   p?.voucher_date   ?? '—',
      amount_allocated:       a.amount_allocated,
    }
  })
}

// ── Company-wide outstanding bills (for Receivables/Payables per-invoice view) ─

export async function fetchAllOpenBills(
  companyId: string,
  nature:    'purchase' | 'sales',
): Promise<BillSummary[]> {
  const { data: vt } = await supabase
    .schema('pramaana').from('voucher_types')
    .select('id').eq('nature', nature)
  const typeIds = ((vt ?? []) as { id: string }[]).map(t => t.id)
  if (!typeIds.length) return []

  type RawVoucher = {
    id: string; voucher_number: string; voucher_date: string
    amount: number; narration: string | null; ref_document_number: string | null
    entity_id: string | null
  }

  const { data: vouchers, error } = await supabase
    .schema('pramaana').from('vouchers')
    .select('id, voucher_number, voucher_date, amount, narration, ref_document_number, entity_id')
    .eq('company_id', companyId)
    .in('voucher_type_id', typeIds)
    .in('status', ['approved', 'completed', 'awaiting_payment', 'posted'])
    .order('voucher_date', { ascending: true })
  if (error) throw new Error(error.message)
  if (!vouchers?.length) return []

  const voucherIds = (vouchers as RawVoucher[]).map(v => v.id)

  const { data: allocs } = await supabase
    .schema('pramaana').from('voucher_allocations')
    .select('bill_voucher_id, amount_allocated')
    .in('bill_voucher_id', voucherIds)

  const allocMap = new Map<string, number>()
  for (const a of (allocs ?? []) as { bill_voucher_id: string; amount_allocated: number }[])
    allocMap.set(a.bill_voucher_id, (allocMap.get(a.bill_voucher_id) ?? 0) + a.amount_allocated)

  const entityIds = [
    ...new Set((vouchers as RawVoucher[]).map(v => v.entity_id).filter(Boolean) as string[])
  ]
  const entityMap = new Map<string, string>()
  if (entityIds.length) {
    const { data: ents } = await supabase
      .schema('registry').from('entities').select('id, display_name').in('id', entityIds)
    for (const e of (ents ?? []) as { id: string; display_name: string }[])
      entityMap.set(e.id, e.display_name)
  }

  return (vouchers as RawVoucher[])
    .map(v => ({
      id:                  v.id,
      voucher_number:      v.voucher_number,
      voucher_date:        v.voucher_date,
      amount:              v.amount,
      outstanding:         Math.max(0, v.amount - (allocMap.get(v.id) ?? 0)),
      narration:           v.narration,
      ref_document_number: v.ref_document_number,
      entity_id:           v.entity_id,
      entity_name:         v.entity_id ? (entityMap.get(v.entity_id) ?? null) : null,
    }))
    .filter(v => v.outstanding > 0.005)
}
