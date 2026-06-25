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
    .in('status', ['approved', 'completed'])
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
    voucher_type_name: (r.voucher_types as unknown as { name: string } | null)?.name ?? '—',
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
    group_name: (l.ledger_groups as unknown as { name: string } | null)?.name ?? '—',
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
    .eq('company_id', companyId).in('status', ['approved', 'completed'])
    .gte('voucher_date', from).lte('voucher_date', to)
    .order('voucher_date', { ascending: true })
    .order('voucher_number', { ascending: true })

  if (vErr) throw new Error(vErr.message)

  if (!vouchers?.length) {
    return {
      ledger_name:     ledger.name as string,
      group_name:      (ledger.ledger_groups as unknown as { name: string } | null)?.name ?? '—',
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
      voucher_type_name: (v.voucher_types as unknown as { name: string } | null)?.name ?? '—',
      party_name:        v.entity_id ? (entityMap.get(v.entity_id) ?? null) : null,
      entry_type:        e.entry_type as 'Dr' | 'Cr',
      amount:            e.amount as number,
      narration:         e.narration,
      running_balance:   running,
    }
  })

  return {
    ledger_name:     ledger.name as string,
    group_name:      (ledger.ledger_groups as unknown as { name: string } | null)?.name ?? '—',
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
    .eq('company_id', companyId).in('status', ['approved', 'completed'])
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
    const grp    = l.ledger_groups as unknown as { id: string; name: string; nature: string } | null
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

// ── Outstanding Ledgers (Receivables / Payables) ──────────────────────────────

export interface AgingBuckets {
  current: number   // 0–30 days
  b31_60:  number   // 31–60 days
  b61_90:  number   // 61–90 days
  b90plus: number   // 91+ days
}

export interface OutstandingLedger {
  ledger_id:    string
  ledger_name:  string
  group_name:   string
  group_nature: LedgerNature
  net_balance:  number   // positive = Dr (receivable), negative = Cr (payable)
  aging:        AgingBuckets
}

function computeAgingFIFO(
  entries:      { voucher_date: string; amount: number; entry_type: 'Dr' | 'Cr' }[],
  openingNet:   number,
  asAtDate:     string,
  isReceivable: boolean,
): AgingBuckets {
  const today = new Date(asAtDate + 'T00:00:00')

  // Treat opening balance as a synthetic entry dated 1 year prior → goes to 90+ bucket
  const allEntries: typeof entries = [...entries]
  if (Math.abs(openingNet) > 0.005) {
    const synDt = new Date(today)
    synDt.setFullYear(synDt.getFullYear() - 1)
    const synDate = synDt.toISOString().slice(0, 10)
    if (isReceivable && openingNet > 0)
      allEntries.unshift({ voucher_date: synDate, amount: openingNet,  entry_type: 'Dr' })
    else if (!isReceivable && openingNet < 0)
      allEntries.unshift({ voucher_date: synDate, amount: -openingNet, entry_type: 'Cr' })
  }

  const chargeType = isReceivable ? 'Dr' : 'Cr'
  const clearType  = isReceivable ? 'Cr' : 'Dr'
  const sorted = [...allEntries].sort((a, b) => a.voucher_date.localeCompare(b.voucher_date))

  const open: { date: Date; remaining: number }[] = []
  let surplus = 0

  for (const e of sorted) {
    if (e.entry_type === chargeType) {
      let rem = e.amount
      if (surplus > 0) {
        const used = Math.min(surplus, rem); surplus -= used; rem -= used
      }
      if (rem > 0.005) open.push({ date: new Date(e.voucher_date + 'T00:00:00'), remaining: rem })
    } else if (e.entry_type === clearType) {
      let left = e.amount
      while (left > 0.005 && open.length > 0) {
        const o = open[0]
        const used = Math.min(left, o.remaining)
        o.remaining -= used; left -= used
        if (o.remaining < 0.005) open.shift()
      }
      if (left > 0.005) surplus += left
    }
  }

  const b: AgingBuckets = { current: 0, b31_60: 0, b61_90: 0, b90plus: 0 }
  for (const o of open) {
    const d = Math.floor((today.getTime() - o.date.getTime()) / 86_400_000)
    if      (d <= 30) b.current += o.remaining
    else if (d <= 60) b.b31_60  += o.remaining
    else if (d <= 90) b.b61_90  += o.remaining
    else              b.b90plus += o.remaining
  }
  return b
}

export async function fetchOutstandingLedgers(
  companyId: string,
  asAtDate:  string,
  natures:   LedgerNature[],
): Promise<OutstandingLedger[]> {
  const { data: ledgers, error: lErr } = await supabase
    .schema('pramaana').from('ledgers')
    .select('id, name, opening_balance, opening_dr_cr, ledger_groups(name, nature)')
    .eq('company_id', companyId).eq('is_active', true)
  if (lErr) throw new Error(lErr.message)

  const relevant = (ledgers ?? []).filter(l => {
    const g = l.ledger_groups as unknown as { nature: string } | null
    return g && natures.includes(g.nature as LedgerNature)
  })
  if (!relevant.length) return []

  const ledgerIds = relevant.map(l => l.id)

  const { data: vs, error: vErr } = await supabase
    .schema('pramaana').from('vouchers')
    .select('id, voucher_date')
    .eq('company_id', companyId).in('status', ['approved', 'completed'])
    .lte('voucher_date', asAtDate)
  if (vErr) throw new Error(vErr.message)

  const dateMap = new Map<string, string>((vs ?? []).map(v => [v.id as string, v.voucher_date as string]))
  const vIds    = (vs ?? []).map(v => v.id as string)

  const eMap = new Map<string, { voucher_date: string; amount: number; entry_type: 'Dr' | 'Cr' }[]>()
  for (const id of ledgerIds) eMap.set(id, [])

  const CHUNK = 200
  for (let i = 0; i < vIds.length; i += CHUNK) {
    const { data: chunk, error: cErr } = await supabase
      .schema('pramaana').from('voucher_entries')
      .select('ledger_id, entry_type, amount, voucher_id')
      .in('voucher_id', vIds.slice(i, i + CHUNK))
      .in('ledger_id', ledgerIds)
    if (cErr) throw new Error(cErr.message)
    for (const e of chunk ?? []) {
      eMap.get(e.ledger_id as string)?.push({
        voucher_date: dateMap.get(e.voucher_id as string) ?? asAtDate,
        amount:       e.amount as number,
        entry_type:   e.entry_type as 'Dr' | 'Cr',
      })
    }
  }

  return relevant
    .map(l => {
      const g      = l.ledger_groups as unknown as { name: string; nature: string } | null
      const nature = (g?.nature ?? 'ASSET') as LedgerNature
      const openNet = (l.opening_dr_cr as string) === 'Dr'
        ? (l.opening_balance as number) : -(l.opening_balance as number)
      const entries   = eMap.get(l.id) ?? []
      const periodNet = entries.reduce((s, e) =>
        s + (e.entry_type === 'Dr' ? e.amount : -e.amount), 0)
      const net = openNet + periodNet
      if (Math.abs(net) < 0.005) return null
      return {
        ledger_id:    l.id,
        ledger_name:  l.name as string,
        group_name:   g?.name ?? '—',
        group_nature: nature,
        net_balance:  net,
        aging:        computeAgingFIFO(entries, openNet, asAtDate, nature === 'ASSET'),
      }
    })
    .filter(Boolean) as OutstandingLedger[]
}

// ── GST Vouchers (for GSTR-1 / GSTR-3B) ─────────────────────────────────────

export interface GSTVoucherRow {
  id:             string
  voucher_number: string
  voucher_date:   string
  party_name:     string | null
  amount:         number
  nature:         string
}

export async function fetchGSTVouchers(
  companyId: string,
  from:      string,
  to:        string,
  nature:    'sales' | 'purchase',
): Promise<GSTVoucherRow[]> {
  const { data: vt } = await supabase
    .schema('pramaana').from('voucher_types').select('id').eq('nature', nature)
  const typeIds = ((vt ?? []) as { id: string }[]).map(t => t.id)
  if (!typeIds.length) return []

  const { data, error } = await supabase
    .schema('pramaana').from('vouchers')
    .select('id, voucher_number, voucher_date, amount, entity_id')
    .eq('company_id', companyId).in('status', ['approved', 'completed'])
    .gte('voucher_date', from).lte('voucher_date', to)
    .in('voucher_type_id', typeIds)
    .order('voucher_date', { ascending: true })
    .order('voucher_number', { ascending: true })
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as unknown as {
    id: string; voucher_number: string; voucher_date: string
    amount: number; entity_id: string | null
  }[]

  const entityIds = [...new Set(rows.map(r => r.entity_id).filter(Boolean) as string[])]
  const entityMap = new Map<string, string>()
  if (entityIds.length > 0) {
    const { data: ents } = await supabase
      .schema('registry').from('entities').select('id, display_name').in('id', entityIds)
    ;(ents ?? []).forEach((e: { id: string; display_name: string }) =>
      entityMap.set(e.id, e.display_name))
  }

  return rows.map(r => ({
    id:             r.id,
    voucher_number: r.voucher_number,
    voucher_date:   r.voucher_date,
    party_name:     r.entity_id ? (entityMap.get(r.entity_id) ?? null) : null,
    amount:         r.amount,
    nature,
  }))
}

// ── Cash Flow Statement (Indirect Method) ─────────────────────────────────────

export interface CashFlowItem    { label: string; amount: number }
export interface CashFlowSection { title: string; items: CashFlowItem[]; total: number }
export interface CashFlowResult  {
  operating:    CashFlowSection
  investing:    CashFlowSection
  financing:    CashFlowSection
  net_change:   number
  opening_cash: number
  closing_cash: number
}

export async function fetchCashFlow(
  companyId: string,
  from:      string,
  to:        string,
): Promise<CashFlowResult> {
  const fromDt = new Date(from + 'T00:00:00')
  fromDt.setDate(fromDt.getDate() - 1)
  const openDate = fromDt.toISOString().slice(0, 10)

  const [tbOpen, tbClose] = await Promise.all([
    fetchTrialBalance(companyId, openDate),
    fetchTrialBalance(companyId, to),
  ])

  const openMap = new Map(tbOpen.rows.map(r => [r.ledger_id, r.net]))

  const isCash    = (n: string) => /cash|bank/i.test(n)
  const isFixed   = (n: string) => /fixed asset|plant|equipment|property|vehicle|machinery|furniture/i.test(n)
  const isLoan    = (n: string) => /loan|borrowing|debenture|mortgage/i.test(n)
  const isCapital = (n: string) => /capital|reserve|equity|retained/i.test(n)

  const closingRows = tbClose.rows
  const totalIncome  = closingRows.filter(r => r.group_nature === 'INCOME').reduce((s, r) => s - r.net, 0)
  const totalExpense = closingRows.filter(r => r.group_nature === 'EXPENSE').reduce((s, r) => s + r.net, 0)
  const netProfit    = totalIncome - totalExpense

  // ── Operating Activities ─────────────────────────────────────────────────────
  const opItems: CashFlowItem[] = [{ label: 'Net Profit / (Loss) for the period', amount: netProfit }]

  const depn = closingRows
    .filter(r => r.group_nature === 'EXPENSE' && /depreciation|amortis/i.test(r.ledger_name))
    .reduce((s, r) => s + r.net, 0)
  if (Math.abs(depn) > 0.005)
    opItems.push({ label: 'Add: Depreciation & Amortisation', amount: depn })

  const wcAssets = closingRows.filter(r =>
    r.group_nature === 'ASSET' && !isCash(r.group_name) && !isFixed(r.group_name))
  const wcLiab = closingRows.filter(r =>
    r.group_nature === 'LIABILITY' && !isLoan(r.group_name) && !isCapital(r.group_name))

  for (const r of wcAssets) {
    const delta = r.net - (openMap.get(r.ledger_id) ?? 0)
    if (Math.abs(delta) > 0.005)
      opItems.push({ label: `(Increase)/Decrease in ${r.ledger_name}`, amount: -delta })
  }
  for (const r of wcLiab) {
    const delta = r.net - (openMap.get(r.ledger_id) ?? 0)
    if (Math.abs(delta) > 0.005)
      opItems.push({ label: `Increase/(Decrease) in ${r.ledger_name}`, amount: -delta })
  }
  const opTotal = opItems.reduce((s, i) => s + i.amount, 0)

  // ── Investing Activities ──────────────────────────────────────────────────────
  const invItems: CashFlowItem[] = []
  for (const r of closingRows.filter(r => r.group_nature === 'ASSET' && isFixed(r.group_name))) {
    const delta = r.net - (openMap.get(r.ledger_id) ?? 0)
    if (Math.abs(delta) > 0.005)
      invItems.push({ label: `(Purchase)/Sale of ${r.ledger_name}`, amount: -delta })
  }
  const invTotal = invItems.reduce((s, i) => s + i.amount, 0)

  // ── Financing Activities ──────────────────────────────────────────────────────
  const finItems: CashFlowItem[] = []
  for (const r of closingRows.filter(r =>
    r.group_nature === 'LIABILITY' && (isLoan(r.group_name) || isCapital(r.group_name)))) {
    const delta = r.net - (openMap.get(r.ledger_id) ?? 0)
    if (Math.abs(delta) > 0.005)
      finItems.push({ label: r.ledger_name, amount: -delta })
  }
  const finTotal = finItems.reduce((s, i) => s + i.amount, 0)

  // ── Cash position ─────────────────────────────────────────────────────────────
  const cashRows   = closingRows.filter(r => r.group_nature === 'ASSET' && isCash(r.group_name))
  const openCash   = cashRows.reduce((s, r) => s + (openMap.get(r.ledger_id) ?? 0), 0)
  const closeCash  = cashRows.reduce((s, r) => s + r.net, 0)

  return {
    operating: { title: 'Cash Flow from Operating Activities', items: opItems,  total: Math.round(opTotal  * 100) / 100 },
    investing:  { title: 'Cash Flow from Investing Activities', items: invItems, total: Math.round(invTotal * 100) / 100 },
    financing:  { title: 'Cash Flow from Financing Activities', items: finItems, total: Math.round(finTotal * 100) / 100 },
    net_change:   Math.round((opTotal + invTotal + finTotal) * 100) / 100,
    opening_cash: Math.round(openCash  * 100) / 100,
    closing_cash: Math.round(closeCash * 100) / 100,
  }
}

// ── Ratio Analysis ────────────────────────────────────────────────────────────

export interface RatioResult {
  current_ratio:       number | null
  quick_ratio:         number | null
  debt_to_equity:      number | null
  net_profit_margin:   number | null
  return_on_assets:    number | null
  return_on_equity:    number | null
  debtors_days:        number | null
  creditors_days:      number | null
}

export async function fetchRatioAnalysis(
  companyId: string,
  to:        string,
): Promise<RatioResult> {
  const tb = await fetchTrialBalance(companyId, to)

  const isFixed   = (n: string) => /fixed asset|plant|equipment|property|vehicle|machinery|furniture/i.test(n)
  const isLoan    = (n: string) => /loan|borrowing|debenture|mortgage/i.test(n)
  const isCapital = (n: string) => /capital|reserve|equity|retained/i.test(n)
  const isInvent  = (n: string) => /inventory|stock|goods/i.test(n)
  const isDebtor  = (n: string) => /debtor|receivable/i.test(n)
  const isCreditor = (n: string) => /creditor|payable/i.test(n)

  const assets  = tb.rows.filter(r => r.group_nature === 'ASSET')
  const liabs   = tb.rows.filter(r => r.group_nature === 'LIABILITY')
  const income  = tb.rows.filter(r => r.group_nature === 'INCOME')
  const expense = tb.rows.filter(r => r.group_nature === 'EXPENSE')

  const currentAssets = assets.filter(r => !isFixed(r.group_name))
  const currentLiabs  = liabs.filter(r => !isLoan(r.group_name) && !isCapital(r.group_name))
  const totalAssets   = assets.reduce((s, r) => s + r.net, 0)
  const totalCA       = currentAssets.reduce((s, r) => s + r.net, 0)
  const totalCL       = currentLiabs.reduce((s, r) => s - r.net, 0)   // CL have Cr balance → negative net
  const inventory     = currentAssets.filter(r => isInvent(r.group_name)).reduce((s, r) => s + r.net, 0)
  const debtors       = currentAssets.filter(r => isDebtor(r.group_name)).reduce((s, r) => s + r.net, 0)
  const creditors     = currentLiabs.filter(r => isCreditor(r.group_name)).reduce((s, r) => s - r.net, 0)
  const totalDebt     = liabs.filter(r => isLoan(r.group_name)).reduce((s, r) => s - r.net, 0)
  const equity        = liabs.filter(r => isCapital(r.group_name)).reduce((s, r) => s - r.net, 0)

  const totalIncome  = income.reduce((s, r) => s - r.net, 0)
  const totalExpense = expense.reduce((s, r) => s + r.net, 0)
  const netProfit    = totalIncome - totalExpense

  const salesIncome = (() => {
    const si = income.filter(r => /sales|revenue|turnover/i.test(r.group_name))
      .reduce((s, r) => s - r.net, 0)
    return si > 0.005 ? si : totalIncome
  })()

  const safe = (n: number, d: number): number | null =>
    d > 0.005 ? Math.round(n / d * 1000) / 1000 : null

  return {
    current_ratio:     safe(totalCA, totalCL),
    quick_ratio:       safe(totalCA - inventory, totalCL),
    debt_to_equity:    safe(totalDebt, equity),
    net_profit_margin: safe(netProfit, salesIncome),
    return_on_assets:  safe(netProfit, totalAssets),
    return_on_equity:  safe(netProfit, equity),
    debtors_days:      salesIncome  > 0.005 ? Math.round(debtors  / salesIncome  * 365) : null,
    creditors_days:    totalExpense > 0.005 ? Math.round(creditors / totalExpense * 365) : null,
  }
}

// ── Exception Reports ─────────────────────────────────────────────────────────

export interface ExceptionVoucher {
  id:             string
  voucher_number: string
  voucher_date:   string
  amount:         number
  status:         string
  created_at:     string
  party_name:     string | null
  voucher_type:   string
  reason:         string
}

export interface ExceptionReport {
  stale_pending:  ExceptionVoucher[]
  backdated:      ExceptionVoucher[]
  round_figures:  ExceptionVoucher[]
  no_narration:   ExceptionVoucher[]
  high_value:     ExceptionVoucher[]
}

export async function fetchExceptionReport(
  companyId: string,
  from:      string,
  to:        string,
): Promise<ExceptionReport> {
  const { data, error } = await supabase
    .schema('pramaana').from('vouchers')
    .select('id, voucher_number, voucher_date, amount, status, narration, created_at, entity_id, voucher_types(name)')
    .eq('company_id', companyId)
    .gte('voucher_date', from).lte('voucher_date', to)
    .order('voucher_date', { ascending: false })
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as unknown as {
    id: string; voucher_number: string; voucher_date: string
    amount: number; status: string; narration: string | null
    created_at: string; entity_id: string | null
    voucher_types: { name: string } | null
  }[]

  const entityIds = [...new Set(rows.map(r => r.entity_id).filter(Boolean) as string[])]
  const entityMap = new Map<string, string>()
  if (entityIds.length > 0) {
    const { data: ents } = await supabase
      .schema('registry').from('entities').select('id, display_name').in('id', entityIds)
    ;(ents ?? []).forEach((e: { id: string; display_name: string }) =>
      entityMap.set(e.id, e.display_name))
  }

  const toRow = (r: typeof rows[0], reason: string): ExceptionVoucher => ({
    id: r.id, voucher_number: r.voucher_number, voucher_date: r.voucher_date,
    amount: r.amount, status: r.status, created_at: r.created_at,
    party_name: r.entity_id ? (entityMap.get(r.entity_id) ?? null) : null,
    voucher_type: r.voucher_types?.name ?? '—', reason,
  })

  const now = new Date()

  const stalePending = rows
    .filter(r => r.status === 'pending_approval' &&
      now.getTime() - new Date(r.created_at).getTime() > 7 * 86_400_000)
    .map(r => toRow(r,
      `Pending for ${Math.floor((now.getTime() - new Date(r.created_at).getTime()) / 86_400_000)} days`))

  const backdated = rows
    .filter(r => {
      const diff = new Date(r.created_at).getTime() - new Date(r.voucher_date + 'T00:00:00').getTime()
      return diff > 7 * 86_400_000
    })
    .map(r => {
      const d = Math.floor(
        (new Date(r.created_at).getTime() - new Date(r.voucher_date + 'T00:00:00').getTime()) / 86_400_000)
      return toRow(r, `Entered ${d} days after voucher date`)
    })

  const roundFigures = rows
    .filter(r => r.amount >= 100_000 && r.amount % 10_000 === 0)
    .map(r => toRow(r, `Round figure: ₹${r.amount.toLocaleString('en-IN')}`))

  const noNarration = rows
    .filter(r => r.status === 'posted' && r.amount >= 50_000 && !r.narration?.trim())
    .map(r => toRow(r, 'Posted without narration'))

  const postedAmts = rows.filter(r => r.status === 'posted').map(r => r.amount)
  const mean   = postedAmts.reduce((s, a) => s + a, 0) / (postedAmts.length || 1)
  const stdDev = Math.sqrt(postedAmts.reduce((s, a) => s + (a - mean) ** 2, 0) / (postedAmts.length || 1))
  const highValue = rows
    .filter(r => r.status === 'posted' && r.amount > mean + 2 * stdDev && r.amount > mean * 3)
    .map(r => toRow(r, `Unusually high: ₹${r.amount.toLocaleString('en-IN')} (> 2σ from mean)`))

  return { stale_pending: stalePending, backdated, round_figures: roundFigures, no_narration: noNarration, high_value: highValue }
}
