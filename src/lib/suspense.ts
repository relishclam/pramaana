import { supabase } from '@/lib/supabase'
import { getNextSequence } from '@/lib/vouchers'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SuspenseVoucher {
  id:               string
  company_id:       string
  voucher_number:   string
  voucher_date:     string
  amount:           number
  status:           string        // 'pending_approval'|'open'|'partial'|'closed'|'rejected'
  narration:        string | null
  is_suspense:      boolean
  suspense_purpose: string | null
  suspense_balance: number | null
  entity_id:        string | null
  created_by:       string
  created_at:       string
  entity_name:      string | null
  entity_mobile:    string | null
  created_by_name:  string
  voucher_type:     { code: string; name: string; prefix: string }
  session:          SuspenseSession | null
}

export interface SuspenseSession {
  id:                   string
  company_id:           string
  entity_id:            string | null
  initiated_by:         string
  total_advance_amount: number
  total_settled_amount: number
  status:               string  // 'open'|'partial'|'completed'
  token:                string
  expires_at:           string | null
  advance_voucher_id:   string | null
  completed_at:         string | null
  notes:                string | null
  created_at:           string
}

export interface SuspenseSettlement {
  id:                    string
  company_id:            string
  entity_id:             string | null
  advance_voucher_id:    string
  settlement_voucher_id: string | null
  advance_amount:        number
  settled_amount:        number | null
  status:                string  // 'pending'|'approved'|'rejected'
  entry_type:            string  // 'expense'|'refund'|'topup'
  description:           string | null
  head_of_account:       string | null
  reference_number:      string | null
  invoice_available:     boolean | null
  settled_at:            string | null
  settled_by:            string | null
  notes:                 string | null
  created_at:            string
  settlement_session_id: string | null
}

export interface PublicSession {
  session_id:           string
  company_id:           string
  entity_id:            string | null
  total_advance_amount: number
  total_settled_amount: number
  session_status:       string
  advance_voucher_id:   string
  suspense_purpose:     string | null
  voucher_amount:       number
  suspense_balance:     number | null
  voucher_status:       string
}

export interface VoucherEntryPayload {
  ledger_id:  string
  entry_type: 'Dr' | 'Cr'
  amount:     number
  narration:  string | null
}

export interface CreateSuspensePayload {
  company_id:       string
  voucher_type_id:  string
  voucher_date:     string
  entity_id:        string | null
  amount:           number
  suspense_purpose: string
  payment_mode:     string | null
  bank_ledger_id:   string | null
  cost_centre_id:   string | null
  narration:        string | null
  created_by:       string
}

export interface SubmitExpensePayload {
  advance_voucher_id: string
  session_id:         string | null
  company_id:         string
  entity_id:          string | null
  amount:             number
  entry_type:         'expense' | 'refund'
  description:        string
  head_of_account:    string | null
  reference_number:   string | null
  invoice_available:  boolean
  attachment_path:    string | null
}

const PAGE_SIZE = 50

// ── Fetch suspense voucher list ───────────────────────────────────────────────

export async function fetchSuspenseVouchers(
  companyId: string,
  userId:    string,
  role:      string | null,
  page = 0,
): Promise<{ rows: SuspenseVoucher[]; hasMore: boolean }> {
  type RawRow = {
    id: string; voucher_number: string; voucher_date: string
    amount: number; status: string; narration: string | null
    is_suspense: boolean; suspense_purpose: string | null; suspense_balance: number | null
    entity_id: string | null; created_by: string; created_at: string; company_id: string
    voucher_type: { code: string; name: string; prefix: string } | null
  }

  let q = supabase
    .schema('pramaana')
    .from('vouchers')
    .select(
      'id, voucher_number, voucher_date, amount, status, narration, is_suspense, suspense_purpose, suspense_balance, entity_id, created_by, created_at, company_id, voucher_type:voucher_types(code, name, prefix)'
    )
    .eq('company_id', companyId)
    .eq('is_suspense', true)
    .order('voucher_date', { ascending: false })
    .order('created_at',   { ascending: false })
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)  // fetch +1 for hasMore

  const { data, error } = await q
  if (error) throw new Error('Failed to load suspense vouchers: ' + error.message)

  const rawRows = (data ?? []) as unknown as RawRow[]
  const hasMore = rawRows.length > PAGE_SIZE
  const rows    = hasMore ? rawRows.slice(0, PAGE_SIZE) : rawRows

  if (rows.length === 0) return { rows: [], hasMore: false }

  const creatorIds = [...new Set(rows.map(r => r.created_by))]
  const entityIds  = [...new Set(rows.map(r => r.entity_id).filter(Boolean) as string[])]
  const voucherIds = rows.map(r => r.id)

  const [profilesRes, entitiesRes, sessionsRes] = await Promise.all([
    supabase.schema('registry').from('profiles').select('id, full_name').in('id', creatorIds),
    entityIds.length > 0
      ? supabase.schema('registry').from('entities').select('id, display_name, mobile').in('id', entityIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string; mobile: string | null }[] }),
    supabase.schema('pramaana').from('settlement_sessions').select('*').in('advance_voucher_id', voucherIds),
  ])

  const profileMap = new Map(
    ((profilesRes.data ?? []) as { id: string; full_name: string | null }[])
      .map(p => [p.id, p.full_name ?? 'Unknown'])
  )
  const entityMap = new Map(
    ((entitiesRes.data ?? []) as { id: string; display_name: string; mobile: string | null }[])
      .map(e => [e.id, e.display_name])
  )
  const entityMobileMap = new Map(
    ((entitiesRes.data ?? []) as { id: string; display_name: string; mobile: string | null }[])
      .map(e => [e.id, e.mobile ?? null])
  )
  const sessionMap = new Map<string, SuspenseSession>(
    ((sessionsRes.data ?? []) as SuspenseSession[])
      .filter(s => s.advance_voucher_id)
      .map(s => [s.advance_voucher_id!, s])
  )

  return {
    rows: rows.map(r => ({
      id:               r.id,
      company_id:       r.company_id,
      voucher_number:   r.voucher_number,
      voucher_date:     r.voucher_date,
      amount:           r.amount,
      status:           r.status,
      narration:        r.narration,
      is_suspense:      r.is_suspense,
      suspense_purpose: r.suspense_purpose,
      suspense_balance: r.suspense_balance,
      entity_id:        r.entity_id,
      created_by:       r.created_by,
      created_at:       r.created_at,
      entity_name:      r.entity_id ? (entityMap.get(r.entity_id) ?? null) : null,
      entity_mobile:    r.entity_id ? (entityMobileMap.get(r.entity_id) ?? null) : null,
      created_by_name:  profileMap.get(r.created_by) ?? 'Unknown',
      voucher_type:     r.voucher_type ?? { code: '?', name: 'Unknown', prefix: '' },
      session:          sessionMap.get(r.id) ?? null,
    })),
    hasMore,
  }
}

// ── Fetch session for one advance ─────────────────────────────────────────────

export async function fetchSuspenseSession(advanceVoucherId: string): Promise<SuspenseSession | null> {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('settlement_sessions')
    .select('*')
    .eq('advance_voucher_id', advanceVoucherId)
    .maybeSingle()
  if (error) throw new Error('Failed to load session: ' + error.message)
  return data as SuspenseSession | null
}

// ── Fetch settlement entries for one advance ──────────────────────────────────

export async function fetchSuspenseSettlements(advanceVoucherId: string): Promise<SuspenseSettlement[]> {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('suspense_settlements')
    .select('*')
    .eq('advance_voucher_id', advanceVoucherId)
    .order('created_at', { ascending: true })
  if (error) throw new Error('Failed to load settlements: ' + error.message)
  return (data ?? []) as SuspenseSettlement[]
}

// ── Create suspense advance voucher (accounts) ────────────────────────────────

export async function createSuspenseVoucher(
  payload: CreateSuspensePayload,
  entries: VoucherEntryPayload[],
): Promise<string> {
  const { data: voucher, error: vErr } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .insert({
      company_id:       payload.company_id,
      voucher_type_id:  payload.voucher_type_id,
      voucher_number:   'SUS-DRAFT',
      voucher_date:     payload.voucher_date,
      entity_id:        payload.entity_id,
      amount:           payload.amount,
      payment_mode:     payload.payment_mode,
      bank_ledger_id:   payload.bank_ledger_id,
      cost_centre_id:   payload.cost_centre_id,
      narration:        payload.narration,
      is_suspense:      true,
      suspense_purpose: payload.suspense_purpose,
      suspense_balance: payload.amount,
      status:           'pending_approval',
      created_by:       payload.created_by,
    })
    .select('id')
    .single()
  if (vErr) throw new Error('Failed to create suspense voucher: ' + vErr.message)

  const { error: eErr } = await supabase
    .schema('pramaana')
    .from('voucher_entries')
    .insert(
      entries.map(e => ({
        voucher_id: voucher.id,
        ledger_id:  e.ledger_id,
        entry_type: e.entry_type,
        amount:     e.amount,
        narration:  e.narration,
        sort_order: 0,
      }))
    )
  if (eErr) {
    await supabase.schema('pramaana').from('vouchers').delete().eq('id', voucher.id)
    throw new Error('Failed to save entries: ' + eErr.message)
  }

  return voucher.id
}

// ── Approve advance (admin) → generates real SUS number, sets status = 'open' ─

export async function approveSuspenseVoucher(
  voucherId:   string,
  companyId:   string,
  companyCode: string,
  prefix:      string,
  approvedBy:  string,
): Promise<void> {
  const voucherNumber = await getNextSequence(companyId, companyCode, prefix)
  const { error } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update({
      voucher_number: voucherNumber,
      status:         'open',
      posted_at:      new Date().toISOString(),
      posted_by:      approvedBy,
    })
    .eq('id', voucherId)
    .eq('status', 'pending_approval')
  if (error) throw new Error('Failed to approve voucher: ' + error.message)
}

// ── Reject advance (admin) ────────────────────────────────────────────────────

export async function rejectSuspenseVoucher(
  voucherId:  string,
  rejectedBy: string,
  reason:     string,
): Promise<void> {
  const { error } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update({
      status:              'rejected',
      cancelled_at:        new Date().toISOString(),
      cancelled_by:        rejectedBy,
      cancellation_reason: reason,
    })
    .eq('id', voucherId)
    .eq('status', 'pending_approval')
  if (error) throw new Error('Failed to reject voucher: ' + error.message)
}

// ── Create or rotate settlement session token (accounts → sends SMS link) ─────

export async function createOrRefreshSession(
  companyId:          string,
  entityId:           string,
  initiatedBy:        string,
  advanceVoucherId:   string,
  totalAdvanceAmount: number,
): Promise<SuspenseSession> {
  const existing = await supabase
    .schema('pramaana')
    .from('settlement_sessions')
    .select('id')
    .eq('advance_voucher_id', advanceVoucherId)
    .maybeSingle()

  if (existing.data?.id) {
    // Rotate token — old link is deactivated
    const { data, error } = await supabase
      .schema('pramaana')
      .from('settlement_sessions')
      .update({ token: crypto.randomUUID(), updated_at: new Date().toISOString() })
      .eq('id', existing.data.id)
      .select('*')
      .single()
    if (error) throw new Error('Failed to refresh session: ' + error.message)
    return data as SuspenseSession
  }

  const { data, error } = await supabase
    .schema('pramaana')
    .from('settlement_sessions')
    .insert({
      company_id:           companyId,
      entity_id:            entityId,
      initiated_by:         initiatedBy,
      advance_voucher_id:   advanceVoucherId,
      total_advance_amount: totalAdvanceAmount,
      total_settled_amount: 0,
      status:               'open',
      token:                crypto.randomUUID(),
    })
    .select('*')
    .single()
  if (error) throw new Error('Failed to create session: ' + error.message)
  return data as SuspenseSession
}

// ── Build the staff settlement URL from a token ───────────────────────────────

export function buildSettlementUrl(token: string): string {
  const origin = typeof window !== 'undefined'
    ? window.location.origin
    : 'https://pramaana-tau.vercel.app'
  return `${origin}/settle/${token}`
}

// ── Add top-up (accounts — auto-approved) ────────────────────────────────────

export async function addTopUp(
  advanceVoucherId: string,
  companyId:        string,
  entityId:         string | null,
  amount:           number,
  description:      string,
  addedBy:          string,
): Promise<void> {
  // 1. Insert auto-approved topup settlement entry
  const { error: sErr } = await supabase
    .schema('pramaana')
    .from('suspense_settlements')
    .insert({
      company_id:         companyId,
      entity_id:          entityId,
      advance_voucher_id: advanceVoucherId,
      advance_amount:     amount,
      settled_amount:     0,
      entry_type:         'topup',
      description,
      status:             'approved',
      settled_at:         new Date().toISOString(),
      settled_by:         addedBy,
    })
  if (sErr) throw new Error('Failed to record top-up: ' + sErr.message)

  // 2. Increase voucher amount + balance; reopen if was closed
  const { data: v, error: vFetchErr } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .select('amount, suspense_balance, status')
    .eq('id', advanceVoucherId)
    .single()
  if (vFetchErr) throw new Error('Failed to fetch voucher: ' + vFetchErr.message)

  const updates: Record<string, unknown> = {
    amount:           (v.amount ?? 0) + amount,
    suspense_balance: (v.suspense_balance ?? 0) + amount,
  }
  if (v.status === 'closed') updates.status = 'partial'

  const { error: vErr } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update(updates)
    .eq('id', advanceVoucherId)
  if (vErr) throw new Error('Failed to update voucher balance: ' + vErr.message)

  // 3. Update session total_advance_amount
  const { data: sess } = await supabase
    .schema('pramaana')
    .from('settlement_sessions')
    .select('id, total_advance_amount')
    .eq('advance_voucher_id', advanceVoucherId)
    .maybeSingle()
  if (sess?.id) {
    await supabase
      .schema('pramaana')
      .from('settlement_sessions')
      .update({ total_advance_amount: (sess.total_advance_amount ?? 0) + amount })
      .eq('id', sess.id)
  }
}

// ── Approve settlement entry (accounts) ──────────────────────────────────────

export async function approveSettlement(
  settlementId: string,
  approvedBy:   string,
  notes?:       string,
): Promise<void> {
  const { data: s, error: fetchErr } = await supabase
    .schema('pramaana')
    .from('suspense_settlements')
    .select('settled_amount, advance_voucher_id, entry_type, status')
    .eq('id', settlementId)
    .single()
  if (fetchErr || !s) throw new Error('Settlement not found')
  if (s.status !== 'pending') throw new Error('Settlement is not in pending state')

  const { error } = await supabase
    .schema('pramaana')
    .from('suspense_settlements')
    .update({
      status:     'approved',
      settled_at: new Date().toISOString(),
      settled_by: approvedBy,
      notes:      notes ?? null,
    })
    .eq('id', settlementId)
  if (error) throw new Error('Failed to approve settlement: ' + error.message)

  // Recalculate voucher balance
  const { data: v, error: vErr } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .select('suspense_balance, amount')
    .eq('id', s.advance_voucher_id)
    .single()
  if (vErr || !v) return

  const delta = s.entry_type === 'expense'
    ? -(s.settled_amount ?? 0)
    : (s.entry_type === 'refund' ? +(s.settled_amount ?? 0) : 0)

  const newBalance = Math.max(0, (v.suspense_balance ?? v.amount) + delta)
  const newStatus  = newBalance === 0 ? 'closed' : 'partial'

  await supabase
    .schema('pramaana')
    .from('vouchers')
    .update({ suspense_balance: newBalance, status: newStatus })
    .eq('id', s.advance_voucher_id)

  // Update session totals
  const { data: sess } = await supabase
    .schema('pramaana')
    .from('settlement_sessions')
    .select('id, total_settled_amount')
    .eq('advance_voucher_id', s.advance_voucher_id)
    .maybeSingle()
  if (sess?.id) {
    const newSettled = (sess.total_settled_amount ?? 0) + (s.settled_amount ?? 0)
    await supabase
      .schema('pramaana')
      .from('settlement_sessions')
      .update({
        total_settled_amount: newSettled,
        status:               newBalance === 0 ? 'completed' : 'partial',
        completed_at:         newBalance === 0 ? new Date().toISOString() : null,
      })
      .eq('id', sess.id)
  }
}

// ── Reject settlement entry (accounts) ───────────────────────────────────────

export async function rejectSettlement(
  settlementId: string,
  rejectedBy:   string,
  reason:       string,
): Promise<void> {
  const { error } = await supabase
    .schema('pramaana')
    .from('suspense_settlements')
    .update({
      status:     'rejected',
      settled_at: new Date().toISOString(),
      settled_by: rejectedBy,
      notes:      reason,
    })
    .eq('id', settlementId)
    .eq('status', 'pending')
  if (error) throw new Error('Failed to reject settlement: ' + error.message)
}

// ── Public: look up session by token (no auth required) ──────────────────────
// Used by /settle/:token page on staff's phone.

export async function getSessionByToken(token: string): Promise<PublicSession | null> {
  const { data: session, error: sErr } = await supabase
    .schema('pramaana')
    .from('settlement_sessions')
    .select('id, company_id, entity_id, total_advance_amount, total_settled_amount, status, advance_voucher_id, expires_at')
    .eq('token', token)
    .maybeSingle()

  if (sErr || !session) return null
  if (!session.advance_voucher_id) return null

  const { data: voucher, error: vErr } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .select('suspense_purpose, amount, suspense_balance, status')
    .eq('id', session.advance_voucher_id)
    .single()

  if (vErr || !voucher) return null
  if (voucher.status === 'closed' || voucher.status === 'rejected') return null

  return {
    session_id:           session.id,
    company_id:           session.company_id,
    entity_id:            session.entity_id,
    total_advance_amount: session.total_advance_amount,
    total_settled_amount: session.total_settled_amount,
    session_status:       session.status,
    advance_voucher_id:   session.advance_voucher_id,
    suspense_purpose:     voucher.suspense_purpose,
    voucher_amount:       voucher.amount,
    suspense_balance:     voucher.suspense_balance,
    voucher_status:       voucher.status,
  }
}

// ── Public: staff submits an expense entry (no auth required) ─────────────────
// Returns the new settlement row ID.

export async function submitExpenseEntry(payload: SubmitExpensePayload): Promise<string> {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('suspense_settlements')
    .insert({
      advance_voucher_id:    payload.advance_voucher_id,
      settlement_session_id: payload.session_id,
      company_id:            payload.company_id,
      entity_id:             payload.entity_id,
      advance_amount:        0,
      settled_amount:        payload.amount,
      entry_type:            payload.entry_type,
      description:           payload.description,
      head_of_account:       payload.head_of_account,
      reference_number:      payload.reference_number,
      invoice_available:     payload.invoice_available,
      attachment_path:       payload.attachment_path,
      status:                'pending',
    })
    .select('id')
    .single()
  if (error) throw new Error('Failed to submit entry: ' + error.message)
  return data.id
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function suspenseStatusLabel(status: string): string {
  const MAP: Record<string, string> = {
    pending_approval: 'Pending Approval',
    open:             'Open',
    partial:          'Partial',
    closed:           'Closed',
    rejected:         'Rejected',
  }
  return MAP[status] ?? status
}

export function settlementStatusLabel(status: string): string {
  const MAP: Record<string, string> = {
    pending:  'Under Review',
    approved: 'Approved',
    rejected: 'Rejected',
  }
  return MAP[status] ?? status
}
