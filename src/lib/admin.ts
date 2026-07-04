import { supabase } from './supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResetPreview {
  vouchers: number
  ledgers:  number
  groups:   number
  sessions: number
}

export interface ResetResult {
  success:          boolean
  vouchers_deleted: number
  ledgers_deleted:  number
  groups_deleted:   number
  sessions_deleted: number
  sequences_reset:  number
}

export interface LedgerGroupRow {
  _line:       number
  name:        string
  parent_name: string
  nature:      string
  _error?:     string
}

export interface LedgerRow {
  _line:            number
  name:             string
  group_name:       string
  opening_balance:  number
  dr_cr:            'Dr' | 'Cr'
  gstin:            string
  is_bank_account:  boolean
  bank_name:        string
  account_number:   string
  ifsc:             string
  _error?:          string
}

export interface ImportResult {
  imported: number
  skipped:  number
  errors:   { line: number; name: string; reason: string }[]
}

// ── CSV parser ────────────────────────────────────────────────────────────────

export function parseCsvText(raw: string): string[][] {
  // Strip BOM and normalise line endings
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const result: string[][] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const cols: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
        else inQ = !inQ
      } else if (c === ',' && !inQ) {
        cols.push(cur.trim()); cur = ''
      } else {
        cur += c
      }
    }
    cols.push(cur.trim())
    result.push(cols)
  }
  return result
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export async function fetchResetPreview(companyId: string): Promise<ResetPreview> {
  const { data, error } = await supabase.rpc('pramaana_reset_preview', { p_company_id: companyId })
  if (error) throw error
  return data as ResetPreview
}

export async function resetCompanyData(companyId: string): Promise<ResetResult> {
  const { data, error } = await supabase.rpc('pramaana_reset_company_data', { p_company_id: companyId })
  if (error) throw error
  return data as ResetResult
}

// ── Ledger Group import ───────────────────────────────────────────────────────

const VALID_NATURES = new Set(['ASSET', 'LIABILITY', 'INCOME', 'EXPENSE'])

export const LEDGER_GROUPS_TEMPLATE = `Group Name,Parent Group Name,Nature (ASSET/LIABILITY/INCOME/EXPENSE)
Buildings,Fixed Assets,ASSET
Machinery,Fixed Assets,ASSET
Furniture & Fixtures,Fixed Assets,ASSET
Electricity Charges,Indirect Expenses,EXPENSE
Repairs & Maintenance,Indirect Expenses,EXPENSE
Salary - Management,Direct Expenses,EXPENSE
Bank Charges,Indirect Expenses,EXPENSE
`

export function parseLedgerGroupsCsv(text: string): LedgerGroupRow[] {
  const rows = parseCsvText(text)
  if (rows.length < 2) return []
  return rows.slice(1).map((cols, i) => {
    const nature = (cols[2] ?? '').trim().toUpperCase()
    const row: LedgerGroupRow = {
      _line:       i + 2,
      name:        (cols[0] ?? '').trim(),
      parent_name: (cols[1] ?? '').trim(),
      nature,
    }
    if (!row.name) {
      row._error = 'Name is required'
    } else if (!VALID_NATURES.has(row.nature)) {
      row._error = `Nature must be ASSET, LIABILITY, INCOME, or EXPENSE (got "${row.nature}")`
    }
    return row
  })
}

export async function importLedgerGroups(
  companyId: string,
  rows: LedgerGroupRow[],
  onProgress: (done: number, total: number) => void,
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] }
  const valid = rows.filter(r => !r._error)

  // Build name→id map: system groups first
  const { data: sysGroups } = await supabase
    .schema('pramaana').from('ledger_groups').select('id, name').is('company_id', null)
  const { data: coGroups } = await supabase
    .schema('pramaana').from('ledger_groups').select('id, name').eq('company_id', companyId)

  const nameToId = new Map<string, string>()
  ;[...(sysGroups ?? []), ...(coGroups ?? [])].forEach(g => nameToId.set(g.name.toLowerCase(), g.id))

  // Two-pass: root groups (no parent) before child groups
  const sorted = [
    ...valid.filter(r => !r.parent_name),
    ...valid.filter(r =>  r.parent_name),
  ]

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i]
    const parentId = row.parent_name ? (nameToId.get(row.parent_name.toLowerCase()) ?? null) : null

    if (row.parent_name && !parentId) {
      result.errors.push({ line: row._line, name: row.name, reason: `Parent group "${row.parent_name}" not found — check spelling or add it first` })
      result.skipped++
      onProgress(i + 1, sorted.length)
      continue
    }

    // Derive a stable code from the name
    const code = row.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)

    // Check if already exists by name
    const existing = nameToId.get(row.name.toLowerCase())
    if (existing) {
      // Already present (e.g. re-running after partial import) — treat as success
      result.imported++
      onProgress(i + 1, sorted.length)
      continue
    }

    const { data, error } = await supabase
      .schema('pramaana').from('ledger_groups')
      .insert({ company_id: companyId, code, name: row.name, nature: row.nature, parent_id: parentId })
      .select('id, name')
      .single()

    if (error || !data) {
      result.errors.push({ line: row._line, name: row.name, reason: error?.message ?? 'Insert failed' })
      result.skipped++
    } else {
      nameToId.set(row.name.toLowerCase(), data.id)
      result.imported++
    }
    onProgress(i + 1, sorted.length)
  }

  return result
}

// ── Ledger import ─────────────────────────────────────────────────────────────

export const LEDGERS_TEMPLATE = `Ledger Name,Group Name,Opening Balance,Dr/Cr,GSTIN,Is Bank Account (Y/N),Bank Name,Account Number,IFSC
State Bank of India - CC,Bank Accounts,250000,Dr,,Y,State Bank of India,12345678901,SBIN0001234
Cash in Hand,Cash in Hand,15000,Dr,,N,,,
Coastal Suppliers Pvt Ltd,Sundry Creditors,180000,Cr,32AAUFR0742E1ZB,N,,,
Kerala Foods Pvt Ltd,Sundry Debtors,95000,Dr,32ABCDE1234F1Z5,N,,,
Electricity Expense,Indirect Expenses,0,Dr,,N,,,
Salaries Payable,Current Liabilities,45000,Cr,,N,,,
`

export function parseLedgersCsv(text: string): LedgerRow[] {
  const rows = parseCsvText(text)
  if (rows.length < 2) return []
  return rows.slice(1).map((cols, i) => {
    // Strip ₹, commas, spaces from balance; handle Indian number format
    const balStr  = (cols[2] ?? '').replace(/[₹,\s]/g, '')
    const balance = Math.abs(parseFloat(balStr) || 0)
    const drCrRaw = (cols[3] ?? '').trim().toLowerCase()
    const row: LedgerRow = {
      _line:           i + 2,
      name:            (cols[0] ?? '').trim(),
      group_name:      (cols[1] ?? '').trim(),
      opening_balance: balance,
      dr_cr:           drCrRaw.startsWith('cr') ? 'Cr' : 'Dr',
      gstin:           (cols[4] ?? '').trim(),
      is_bank_account: (cols[5] ?? '').toLowerCase().startsWith('y'),
      bank_name:       (cols[6] ?? '').trim(),
      account_number:  (cols[7] ?? '').trim(),
      ifsc:            (cols[8] ?? '').trim(),
    }
    if (!row.name)       row._error = 'Name is required'
    else if (!row.group_name) row._error = 'Group Name is required'
    return row
  })
}

export async function importLedgers(
  companyId: string,
  rows: LedgerRow[],
  onProgress: (done: number, total: number) => void,
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] }
  const valid = rows.filter(r => !r._error)

  // Load all groups for this company (system + company-specific)
  const { data: allGroups } = await supabase
    .schema('pramaana').from('ledger_groups').select('id, name')
    .or(`company_id.eq.${companyId},company_id.is.null`)

  const groupMap = new Map<string, string>()
  ;(allGroups ?? []).forEach(g => groupMap.set(g.name.toLowerCase(), g.id))

  for (let i = 0; i < valid.length; i++) {
    const row = valid[i]
    const groupId = groupMap.get(row.group_name.toLowerCase())

    if (!groupId) {
      result.errors.push({ line: row._line, name: row.name, reason: `Group "${row.group_name}" not found — import Ledger Groups first or check spelling` })
      result.skipped++
      onProgress(i + 1, valid.length)
      continue
    }

    const { error } = await supabase
      .schema('pramaana').from('ledgers')
      .upsert({
        company_id:       companyId,
        group_id:         groupId,
        name:             row.name,
        opening_balance:  row.opening_balance,
        opening_dr_cr:    row.dr_cr,
        gstin:            row.gstin  || null,
        is_bank_account:  row.is_bank_account,
        bank_name:        row.bank_name       || null,
        account_number:   row.account_number  || null,
        ifsc:             row.ifsc             || null,
      }, { onConflict: 'company_id,name' })

    if (error) {
      result.errors.push({ line: row._line, name: row.name, reason: error.message })
      result.skipped++
    } else {
      result.imported++
    }
    onProgress(i + 1, valid.length)
  }

  return result
}

// ── Template download helper ──────────────────────────────────────────────────

export function downloadCsvTemplate(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Period Lock ───────────────────────────────────────────────────────────────
// One row per company in pramaana.period_locks. Vouchers dated on or before
// lock_date are blocked from INSERT / UPDATE / DELETE by DB trigger.

export interface PeriodLock {
  id:        string
  company_id: string
  lock_date:  string   // ISO date: 'YYYY-MM-DD'
  locked_by:  string   // auth.users.id
  locked_at:  string   // ISO timestamptz
  note:       string | null
}

/** Returns the current lock for a company, or null if unlocked. */
export async function fetchPeriodLock(companyId: string): Promise<PeriodLock | null> {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('period_locks')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error('Failed to load period lock: ' + error.message)
  return (data as PeriodLock | null) ?? null
}

/** Set (or move) the lock date for a company. Uses upsert on company_id. */
export async function setPeriodLock(
  companyId: string,
  lockDate:  string,
  lockedBy:  string,
  note?:     string,
): Promise<void> {
  const { error } = await supabase
    .schema('pramaana')
    .from('period_locks')
    .upsert(
      {
        company_id: companyId,
        lock_date:  lockDate,
        locked_by:  lockedBy,
        locked_at:  new Date().toISOString(),
        note:       note ?? null,
      },
      { onConflict: 'company_id' },
    )
  if (error) throw new Error('Failed to set period lock: ' + error.message)
}

/** Remove the lock for a company (unlock). */
export async function clearPeriodLock(companyId: string): Promise<void> {
  const { error } = await supabase
    .schema('pramaana')
    .from('period_locks')
    .delete()
    .eq('company_id', companyId)
  if (error) throw new Error('Failed to clear period lock: ' + error.message)
}
