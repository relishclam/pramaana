import { supabase } from '@/lib/supabase'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Default date range = current Indian fiscal year (Apr 1 – Mar 31). */
export function currentFY(): { from: string; to: string } {
  const today = new Date()
  const year  = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1
  return { from: `${year}-04-01`, to: `${year + 1}-03-31` }
}

export function fmtDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

export function fmtAmt(n: number): string {
  return '₹' + Math.abs(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })
}

/** Format a signed net balance: +ve = Dr, −ve = Cr. Returns "—" if zero. */
export function fmtBalance(net: number): string {
  if (Math.abs(net) < 0.005) return '—'
  return fmtAmt(net) + (net > 0 ? ' Dr' : ' Cr')
}

// ── Day Book ──────────────────────────────────────────────────────────────────

export interface DayBookRow {
  id:                string
  voucher_number:    string
  voucher_date:      string
  narration:         string | null
  amount:            number
  voucher_type_name: string
  party_name:        string | null
}

export async function fetchDayBook(
  companyId: string,
  from:      string,
  to:        string,
): Promise<DayBookRow[]> {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .select('id, voucher_number, voucher_date, narration, amount, entity_id, voucher_types(name)')
    .eq('company_id', companyId)
    .eq('status', 'posted')
    .gte('voucher_date', from)
    .lte('voucher_date', to)
    .order('voucher_date', { ascending: true })
    .order('voucher_number', { ascending: true })

  if (error) throw new Error(error.message)
  const rows = data ?? []

  // Cross-schema join for entity names
  const entityIds = [...new Set(rows.map(r => r.entity_id).filter(Boolean) as string[])]
  const entityMap = new Map<string, string>()
  if (entityIds.length > 0) {
    const { data: ents } = await supabase
      .schema('registry').from('entities')
      .select('id, display_name').in('id', entityIds)
    ;(ents ?? []).forEach(e => entityMap.set(e.id as string, e.display_name as string))
  }

  return rows.map(r => ({
    id:                r.id,
    voucher_number:    r.voucher_number,
    voucher_date:      r.voucher_date,
    narration:         r.narration,
    amount:            r.amount,
    voucher_type_name: (r.voucher_types as { name: string } | null)?.name ?? '—',
    party_name:        r.entity_id ? (entityMap.get(r.entity_id) ?? null) : null,
  }))
}

// ── Ledger options (for LedgerStatement selector) ─────────────────────────────

export interface LedgerOption {
  id:         string
  name:       string
  group_name: string
}

export async function fetchLedgerOptions(companyId: string): Promise<LedgerOption[]> {
  const { data, error } = await supabase
    .schema('pramaana').from('ledgers')
    .select('id, name, ledger_groups(name)')
    .eq('company_id', companyId).eq('is_active', true)
    .order('name', { ascending: true })

  if (error) throw new Error(error.message)
  return (data ?? []).map(l => ({
    id:         l.id,
    name:       l.name,
    group_name: (l.ledger_groups as { name: string } | null)?.name ?? '—',
  }))
}

// ── Ledger Statement ──────────────────────────────────────────────────────────

export interface LedgerStatementRow {
  id:                string
  voucher_date:      string
  voucher_number:    string
  voucher_type_name: string
  party_name:        string | null
  entry_type:        'Dr' | 'Cr'
  amount:            number
  narration:         string | null
  running_balance:   number   // positive = Dr, negative = Cr
}

export interface LedgerStatementResult {
  ledger_name:    string
  group_name:     string
  opening_balance: number
  opening_dr_cr:  'Dr' | 'Cr'
  opening_net:    number      // positive = Dr, negative = Cr
  rows:           LedgerStatementRow[]
  closing_net:    number
}

export async function fetchLedgerStatement(
  companyId: string,
  ledgerId:  string,
  from:      string,
  to:        string,
): Promise<LedgerStatementResult> {
  const { data: ledger, error: lErr } = await supabase
    .schema('pramaana').from('ledgers')
    .select('id, name, opening_balance, opening_dr_cr, ledger_groups(name)')
    .eq('id', ledgerId).maybeSingle()

  if (lErr) throw new Error(lErr.message)
  if (!ledger) throw new Error('Ledger not found')

  const openingNet = (ledger.opening_dr_cr as string) === 'Dr'
    ? (ledger.opening_balance as number)
    : -(ledger.opening_balance as number)

  // Fetch posted vouchers for this company within date range
  const { data: vouchers, error: vErr } = await supabase
    .schema('pramaana').from('vouchers')
    .select('id, voucher_date, voucher_number, entity_id, voucher_types(name)')
    .eq('company_id', companyId).eq('status', 'posted')
    .gte('voucher_date', from).lte('voucher_date', to)
    .order('voucher_date', { ascending: true })
    .order('voucher_number', { ascending: true })

  if (vErr) throw new Error(vErr.message)

  if (!vouchers?.length) {
    return {
      ledger_name:     ledger.name as string,
      group_name:      (ledger.ledger_groups as { name: string } | null)?.name ?? '—',
      opening_balance: ledger.opening_balance as number,
      opening_dr_cr:   ledger.opening_dr_cr as 'Dr' | 'Cr',
      opening_net:     openingNet,
      rows:            [],
      closing_net:     openingNet,
    }
  }

  const voucherIds = vouchers.map(v => v.id)
  const voucherMap = new Map(vouchers.map(v => [v.id, v]))

  // Entries for this ledger within those vouchers
  const { data: entries, error: eErr } = await supabase
    .schema('pramaana').from('voucher_entries')
    .select('id, entry_type, amount, narration, voucher_id')
    .eq('ledger_id', ledgerId).in('voucher_id', voucherIds)

  if (eErr) throw new Error(eErr.message)

  // Sort by voucher date/number order
  const sorted = [...(entries ?? [])].sort((a, b) => {
    const av = voucherMap.get(a.voucher_id)
    const bv = voucherMap.get(b.voucher_id)
    if (!av || !bv) return 0
    return av.voucher_date.localeCompare(bv.voucher_date) ||
           av.voucher_number.localeCompare(bv.voucher_number)
  })

  // Entity names (cross-schema)
  const entityIds = [...new Set(
    vouchers.map(v => v.entity_id).filter(Boolean) as string[]
  )]
  const entityMap = new Map<string, string>()
  if (entityIds.length > 0) {
    const { data: ents } = await supabase
      .schema('registry').from('entities')
      .select('id, display_name').in('id', entityIds)
    ;(ents ?? []).forEach(e => entityMap.set(e.id as string, e.display_name as string))
  }

  let running = openingNet
  const rows: LedgerStatementRow[] = sorted.map(e => {
    const v = voucherMap.get(e.voucher_id)!
    running += e.entry_type === 'Dr' ? (e.amount as number) : -(e.amount as number)
    return {
      id:                e.id,
      voucher_date:      v.voucher_date,
      voucher_number:    v.voucher_number,
      voucher_type_name: (v.voucher_types as { name: string } | null)?.name ?? '—',
      party_name:        v.entity_id ? (entityMap.get(v.entity_id) ?? null) : null,
      entry_type:        e.entry_type as 'Dr' | 'Cr',
      amount:            e.amount as number,
      narration:         e.narration,
      running_balance:   running,
    }
  })

  return {
    ledger_name:     ledger.name as string,
    group_name:      (ledger.ledger_groups as { name: string } | null)?.name ?? '—',
    opening_balance: ledger.opening_balance as number,
    opening_dr_cr:   ledger.opening_dr_cr as 'Dr' | 'Cr',
    opening_net:     openingNet,
    rows,
    closing_net:     running,
  }
}

// ── Trial Balance ─────────────────────────────────────────────────────────────

export type LedgerNature = 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE'

export interface TrialBalanceLedgerRow {
  ledger_id:       string
  ledger_name:     string
  group_name:      string
  group_nature:    LedgerNature
  opening_balance: number
  opening_dr_cr:   'Dr' | 'Cr'
  period_dr:       number
  period_cr:       number
  net:             number  // positive = Dr closing balance, negative = Cr closing balance
}

export interface TrialBalanceResult {
  rows:       TrialBalanceLedgerRow[]
  total_dr:   number
  total_cr:   number
  balanced:   boolean
}

export async function fetchTrialBalance(
  companyId: string,
  toDate:    string,
): Promise<TrialBalanceResult> {
  const { data: ledgers, error: lErr } = await supabase
    .schema('pramaana').from('ledgers')
    .select('id, name, opening_balance, opening_dr_cr, ledger_groups(id, name, nature)')
    .eq('company_id', companyId).eq('is_active', true)

  if (lErr) throw new Error(lErr.message)
  if (!ledgers?.length) return { rows: [], total_dr: 0, total_cr: 0, balanced: true }

  // Get IDs of all posted vouchers up to toDate for this company
  const { data: voucherRows, error: vErr } = await supabase
    .schema('pramaana').from('vouchers')
    .select('id')
    .eq('company_id', companyId).eq('status', 'posted')
    .lte('voucher_date', toDate)

  if (vErr) throw new Error(vErr.message)

  const drMap = new Map<string, number>()
  const crMap = new Map<string, number>()

  if (voucherRows?.length) {
    const voucherIds  = voucherRows.map(v => v.id)
    const ledgerIds   = ledgers.map(l => l.id)

    // Fetch entries in chunks to stay within URL length limits
    const CHUNK = 200
    for (let i = 0; i < voucherIds.length; i += CHUNK) {
      const chunk = voucherIds.slice(i, i + CHUNK)
      const { data: entries, error: eErr } = await supabase
        .schema('pramaana').from('voucher_entries')
        .select('ledger_id, entry_type, amount')
        .in('voucher_id', chunk)
        .in('ledger_id', ledgerIds)

      if (eErr) throw new Error(eErr.message)
      for (const e of entries ?? []) {
        if (e.entry_type === 'Dr')
          drMap.set(e.ledger_id, (drMap.get(e.ledger_id) ?? 0) + (e.amount as number))
        else
          crMap.set(e.ledger_id, (crMap.get(e.ledger_id) ?? 0) + (e.amount as number))
      }
    }
  }

  const rows: TrialBalanceLedgerRow[] = ledgers.map(l => {
    const grp    = l.ledger_groups as { id: string; name: string; nature: string } | null
    const openNet = (l.opening_dr_cr as string) === 'Dr'
      ? (l.opening_balance as number)
      : -(l.opening_balance as number)
    const pDr = drMap.get(l.id) ?? 0
    const pCr = crMap.get(l.id) ?? 0
    return {
      ledger_id:       l.id,
      ledger_name:     l.name as string,
      group_name:      grp?.name ?? '—',
      group_nature:    (grp?.nature ?? 'ASSET') as LedgerNature,
      opening_balance: l.opening_balance as number,
      opening_dr_cr:   l.opening_dr_cr as 'Dr' | 'Cr',
      period_dr:       pDr,
      period_cr:       pCr,
      net:             openNet + pDr - pCr,
    }
  }).sort((a, b) =>
    a.group_name.localeCompare(b.group_name) ||
    a.ledger_name.localeCompare(b.ledger_name)
  )

  let total_dr = 0, total_cr = 0
  for (const r of rows) {
    if (r.net > 0) total_dr += r.net
    else           total_cr -= r.net
  }

  return {
    rows,
    total_dr: Math.round(total_dr * 100) / 100,
    total_cr: Math.round(total_cr * 100) / 100,
    balanced: Math.abs(total_dr - total_cr) < 0.01,
  }
}
