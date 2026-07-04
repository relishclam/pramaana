/**
 * Tally XML Export — src/lib/tally-export.ts
 *
 * One-time historical migration tool. Generates Tally Prime-compatible
 * XML that imports vouchers from Pramaana into an existing Tally company.
 *
 * CRITICAL CONVENTIONS (verified against Tally Prime import spec):
 *   Dr entry → ISDEEMEDPOSITIVE=Yes, AMOUNT=negative  (e.g. -15000)
 *   Cr entry → ISDEEMEDPOSITIVE=No,  AMOUNT=positive  (e.g. +15000)
 *   Date format: YYYYMMDD — no separators
 *   Ledger names: EXACT string match with Tally chart of accounts
 *
 * ⚠  DO NOT change the sign convention without re-verifying against a
 *    real Tally XML export — this is the #1 silent failure point.
 */

import { supabase } from './supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TallyLedgerMap {
  id:                   string
  company_id:           string
  pramaana_entity_type: 'party' | 'gl_account' | 'gst_ledger' | 'bank_ledger' | 'cash_ledger'
  pramaana_entity_id:   string | null
  pramaana_display_name: string
  tally_ledger_name:    string
  tally_parent_group:   string | null
  is_verified:          boolean
  notes:                string | null
  created_at:           string
  updated_at:           string
}

export interface TallyMasterRow {
  tally_name:      string
  tally_group:     string | null
  opening_balance: number | null
}

export interface ValidationError {
  severity: 'error' | 'warning'
  code:     string
  message:  string
  affected: string[]  // voucher numbers or ledger names
}

export interface ExportManifest {
  company_id:      string
  company_code:    string
  tally_company:   string
  date_from:       string
  date_to:         string
  voucher_count:   number
  by_nature:       Record<string, number>
  ledger_creates:  number
  total_debit_inr: number
  generated_at:    string
}

// ── Voucher nature → Tally VOUCHERTYPENAME ────────────────────────────────────
// These must match the exact voucher type names configured in the target
// Tally company. If the company uses renamed types, edit this map.

export const TALLY_VOUCHER_TYPE: Record<string, string> = {
  payment: 'Payment',
  receipt: 'Receipt',
  journal: 'Journal',
  contra:  'Contra',
  purchase: 'Purchase',
  sales:   'Sales',
}

// ── DB — Tally master import ──────────────────────────────────────────────────

export async function upsertTallyMasterRows(
  companyId: string,
  rows: TallyMasterRow[],
): Promise<void> {
  if (!rows.length) return
  const { error } = await supabase
    .schema('pramaana')
    .from('tally_ledger_master_import')
    .upsert(
      rows.map(r => ({
        company_id:      companyId,
        tally_name:      r.tally_name,
        tally_group:     r.tally_group ?? null,
        opening_balance: r.opening_balance ?? null,
        imported_at:     new Date().toISOString(),
      })),
      { onConflict: 'company_id,tally_name' },
    )
  if (error) throw new Error('Failed to import master rows: ' + error.message)
}

export async function fetchTallyMasterRows(companyId: string): Promise<TallyMasterRow[]> {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('tally_ledger_master_import')
    .select('tally_name, tally_group, opening_balance')
    .eq('company_id', companyId)
    .order('tally_name')
  if (error) throw new Error('Failed to load master rows: ' + error.message)
  return (data ?? []) as TallyMasterRow[]
}

// ── DB — Ledger map CRUD ──────────────────────────────────────────────────────

export async function fetchLedgerMaps(companyId: string): Promise<TallyLedgerMap[]> {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('tally_ledger_map')
    .select('*')
    .eq('company_id', companyId)
    .order('pramaana_entity_type')
    .order('pramaana_display_name')
  if (error) throw new Error('Failed to load ledger maps: ' + error.message)
  return (data ?? []) as TallyLedgerMap[]
}

export async function upsertLedgerMap(
  map: Omit<TallyLedgerMap, 'id' | 'created_at' | 'updated_at'>,
): Promise<void> {
  const { error } = await supabase
    .schema('pramaana')
    .from('tally_ledger_map')
    .upsert(
      { ...map, updated_at: new Date().toISOString() },
      { onConflict: 'company_id,pramaana_display_name' },
    )
  if (error) throw new Error('Failed to save ledger map: ' + error.message)
}

export async function setMapVerified(id: string, verified: boolean): Promise<void> {
  const { error } = await supabase
    .schema('pramaana')
    .from('tally_ledger_map')
    .update({ is_verified: verified, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error('Failed to update verification: ' + error.message)
}

export async function deleteLedgerMap(id: string): Promise<void> {
  const { error } = await supabase
    .schema('pramaana')
    .from('tally_ledger_map')
    .delete()
    .eq('id', id)
  if (error) throw new Error('Failed to delete map: ' + error.message)
}

// ── Auto-match logic ──────────────────────────────────────────────────────────
// Compares Pramaana ledger/party names against the imported Tally master list.
// Exact string matches (case-insensitive, trimmed) → candidate rows (is_verified=false).
// Returns fuzzy suggestions for human review — never auto-verifies fuzzy matches.

function normalise(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ')
}

function similarity(a: string, b: string): number {
  const na = normalise(a), nb = normalise(b)
  if (na === nb) return 1
  // Remove common legal suffixes for comparison
  const strip = (s: string) =>
    s.replace(/\b(pvt\.?|private|ltd\.?|limited|llp|& co\.?)\b/gi, '').trim()
  if (strip(na) === strip(nb)) return 0.95
  // Simple overlap score
  const setA = new Set(na.split(' ')), setB = new Set(nb.split(' '))
  const intersection = [...setA].filter(w => setB.has(w)).length
  const union = new Set([...setA, ...setB]).size
  return union > 0 ? intersection / union : 0
}

export async function runAutoMatch(companyId: string): Promise<{
  exact:  number
  fuzzy:  { pramaana: string; tally: string; score: number }[]
  errors: string[]
}> {
  const master    = await fetchTallyMasterRows(companyId)
  const tallyMap  = new Map(master.map(r => [normalise(r.tally_name), r]))

  // Fetch Pramaana parties (entities linked to this company)
  const { data: entityRoles } = await supabase
    .schema('registry')
    .from('entity_roles')
    .select('entity_id, entity:entities(id, display_name)')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .in('role', ['Vendor', 'Supplier', 'Customer', 'Staff', 'Management', 'Contractor', 'Government', 'Fisher'])

  // Fetch Pramaana GL ledgers (non-bank, non-cash)
  const { data: ledgers } = await supabase
    .schema('pramaana')
    .from('ledgers')
    .select('id, name, is_bank_account')
    .eq('company_id', companyId)
    .eq('is_active', true)

  let exactCount = 0
  const fuzzy: { pramaana: string; tally: string; score: number }[] = []
  const errors: string[] = []

  // Process parties
  const seenEntityIds = new Set<string>()
  for (const er of entityRoles ?? []) {
    const entity = (er.entity as unknown as { id: string; display_name: string } | null)
    if (!entity) continue
    if (seenEntityIds.has(entity.id)) continue
    seenEntityIds.add(entity.id)

    const normName = normalise(entity.display_name)
    const exactMatch = tallyMap.get(normName)

    if (exactMatch) {
      try {
        await upsertLedgerMap({
          company_id:            companyId,
          pramaana_entity_type:  'party',
          pramaana_entity_id:    entity.id,
          pramaana_display_name: entity.display_name,
          tally_ledger_name:     exactMatch.tally_name,
          tally_parent_group:    exactMatch.tally_group ?? null,
          is_verified:           false,  // human must verify even exact matches
          notes:                 'Auto-matched (exact)',
        })
        exactCount++
      } catch (e) {
        errors.push(`${entity.display_name}: ${(e as Error).message}`)
      }
    } else {
      // Fuzzy suggestions — not written to DB, returned for human review
      let best = { name: '', score: 0 }
      for (const [, row] of tallyMap) {
        const score = similarity(entity.display_name, row.tally_name)
        if (score > best.score) best = { name: row.tally_name, score }
      }
      if (best.score >= 0.6) {
        fuzzy.push({ pramaana: entity.display_name, tally: best.name, score: best.score })
      }
    }
  }

  // Process GL ledgers
  for (const ledger of ledgers ?? []) {
    const type: TallyLedgerMap['pramaana_entity_type'] = ledger.is_bank_account ? 'bank_ledger' : 'gl_account'
    const normName = normalise(ledger.name)
    const exactMatch = tallyMap.get(normName)

    if (exactMatch) {
      try {
        await upsertLedgerMap({
          company_id:            companyId,
          pramaana_entity_type:  type,
          pramaana_entity_id:    ledger.id,
          pramaana_display_name: ledger.name,
          tally_ledger_name:     exactMatch.tally_name,
          tally_parent_group:    exactMatch.tally_group ?? null,
          is_verified:           false,
          notes:                 'Auto-matched (exact)',
        })
        exactCount++
      } catch (e) {
        errors.push(`${ledger.name}: ${(e as Error).message}`)
      }
    } else {
      let best = { name: '', score: 0 }
      for (const [, row] of tallyMap) {
        const score = similarity(ledger.name, row.tally_name)
        if (score > best.score) best = { name: row.tally_name, score }
      }
      if (best.score >= 0.6) {
        fuzzy.push({ pramaana: ledger.name, tally: best.name, score: best.score })
      }
    }
  }

  return { exact: exactCount, fuzzy, errors }
}

// ── Pre-flight validation ─────────────────────────────────────────────────────

export async function validateExport(
  companyId: string,
  dateFrom:  string,
  dateTo:    string,
): Promise<ValidationError[]> {
  const errors: ValidationError[] = []

  // 1. Fetch all vouchers in range
  const { data: vouchers, error: vErr } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .select(`
      id, voucher_number, voucher_date, status, amount,
      entity_id,
      voucher_type:voucher_types(nature),
      entries:voucher_entries(entry_type, amount)
    `)
    .eq('company_id', companyId)
    .eq('status', 'posted')
    .gte('voucher_date', dateFrom)
    .lte('voucher_date', dateTo)

  if (vErr) {
    errors.push({ severity: 'error', code: 'QUERY_FAILED', message: vErr.message, affected: [] })
    return errors
  }

  if (!vouchers?.length) {
    errors.push({
      severity: 'warning',
      code:     'NO_VOUCHERS',
      message:  `No posted vouchers found between ${dateFrom} and ${dateTo}.`,
      affected: [],
    })
    return errors
  }

  // 2. Check every voucher balances (Dr = Cr)
  const unbalanced: string[] = []
  for (const v of vouchers) {
    const entries = (v.entries as { entry_type: string; amount: number }[]) ?? []
    const dr = entries.filter(e => e.entry_type === 'Dr').reduce((s, e) => s + e.amount, 0)
    const cr = entries.filter(e => e.entry_type === 'Cr').reduce((s, e) => s + e.amount, 0)
    if (Math.abs(dr - cr) > 0.01) unbalanced.push(v.voucher_number)
  }
  if (unbalanced.length) {
    errors.push({
      severity: 'error',
      code:     'UNBALANCED_VOUCHERS',
      message:  `${unbalanced.length} voucher(s) have Dr ≠ Cr. Fix before export.`,
      affected: unbalanced,
    })
  }

  // 3. Fetch all ledger maps for company
  const maps = await fetchLedgerMaps(companyId)
  const verifiedByDisplayName = new Map(
    maps.filter(m => m.is_verified).map(m => [m.pramaana_display_name.toLowerCase(), m.tally_ledger_name]),
  )

  // 4. Fetch all ledger names used in these vouchers
  const ledgerIds = new Set<string>()
  const entityIds = new Set<string>()
  for (const v of vouchers) {
    if (v.entity_id) entityIds.add(v.entity_id)
  }

  // Fetch ledgers used in entries
  const { data: entryLedgers } = await supabase
    .schema('pramaana')
    .from('voucher_entries')
    .select('ledger_id, ledger:ledgers(name)')
    .in('voucher_id', vouchers.map(v => v.id))

  for (const el of entryLedgers ?? []) ledgerIds.add(el.ledger_id)

  // Build set of ledger names that need mapping
  const unmapped: string[] = []
  for (const el of entryLedgers ?? []) {
    const name = (el.ledger as unknown as { name: string } | null)?.name
    if (name && !verifiedByDisplayName.has(name.toLowerCase())) {
      if (!unmapped.includes(name)) unmapped.push(name)
    }
  }

  // Check party (entity) mappings
  if (entityIds.size > 0) {
    const { data: entities } = await supabase
      .schema('registry')
      .from('entities')
      .select('id, display_name')
      .in('id', [...entityIds])

    for (const e of entities ?? []) {
      if (!verifiedByDisplayName.has(e.display_name.toLowerCase())) {
        if (!unmapped.includes(e.display_name)) unmapped.push(e.display_name)
      }
    }
  }

  if (unmapped.length) {
    errors.push({
      severity: 'error',
      code:     'MISSING_MAPPINGS',
      message:  `${unmapped.length} ledger(s)/part(ies) have no verified Tally mapping. Add them in the Ledger Mapping tab before export.`,
      affected: unmapped.sort(),
    })
  }

  // 5. Check unverified maps exist
  const unverified = maps.filter(m => !m.is_verified).map(m => m.pramaana_display_name)
  if (unverified.length) {
    errors.push({
      severity: 'warning',
      code:     'UNVERIFIED_MAPS',
      message:  `${unverified.length} mapping(s) exist but are not yet verified. They will NOT be used in the export.`,
      affected: unverified,
    })
  }

  return errors
}

// ── XML generation ────────────────────────────────────────────────────────────

function tallyDate(iso: string): string {
  // 'YYYY-MM-DD' → 'YYYYMMDD'
  return iso.replace(/-/g, '')
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function formatAmount(n: number): string {
  // Tally expects up to 2 decimal places, negative for Dr, positive for Cr
  return n.toFixed(2)
}

export async function generateTallyXML(
  companyId:        string,
  tallyCompanyName: string,   // EXACT name as configured in Tally — must be provided by user
  dateFrom:         string,
  dateTo:           string,
): Promise<{ xml: string; manifest: ExportManifest }> {
  if (!tallyCompanyName.trim()) throw new Error('Tally company name is required')

  // Load verified mapping lookup
  const maps     = await fetchLedgerMaps(companyId)
  const mapByDisplayName = new Map(
    maps.filter(m => m.is_verified).map(m => [m.pramaana_display_name.toLowerCase().trim(), m]),
  )
  const mapByEntityId = new Map(
    maps.filter(m => m.is_verified && m.pramaana_entity_id).map(m => [m.pramaana_entity_id!, m]),
  )
  const mapByLedgerId = new Map(
    maps.filter(m => m.is_verified && m.pramaana_entity_id).map(m => [m.pramaana_entity_id!, m]),
  )

  function resolveByName(name: string): string {
    const m = mapByDisplayName.get(name.toLowerCase().trim())
    if (!m) throw new Error(`No verified Tally mapping for: "${name}"`)
    return m.tally_ledger_name
  }

  // Fetch vouchers
  const { data: vouchers, error: vErr } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .select('id, voucher_number, voucher_date, narration, entity_id, voucher_type:voucher_types(nature)')
    .eq('company_id', companyId)
    .eq('status', 'posted')
    .gte('voucher_date', dateFrom)
    .lte('voucher_date', dateTo)
    .order('voucher_date')
    .order('voucher_number')

  if (vErr) throw new Error('Failed to fetch vouchers: ' + vErr.message)
  if (!vouchers?.length) throw new Error('No posted vouchers in the selected date range')

  // Fetch all entries for these vouchers
  const voucherIds = vouchers.map(v => v.id)
  const { data: entries, error: eErr } = await supabase
    .schema('pramaana')
    .from('voucher_entries')
    .select('voucher_id, entry_type, amount, narration, sort_order, ledger:ledgers(id, name)')
    .in('voucher_id', voucherIds)
    .order('sort_order')

  if (eErr) throw new Error('Failed to fetch entries: ' + eErr.message)

  // Fetch entities for party names
  const entityIds = [...new Set(vouchers.map(v => v.entity_id).filter(Boolean))]
  const entityMap = new Map<string, string>()
  if (entityIds.length > 0) {
    const { data: entities } = await supabase
      .schema('registry')
      .from('entities')
      .select('id, display_name')
      .in('id', entityIds as string[])
    for (const e of entities ?? []) entityMap.set(e.id, e.display_name)
  }

  // Group entries by voucher
  const entriesByVoucher = new Map<string, typeof entries>()
  for (const e of entries ?? []) {
    if (!entriesByVoucher.has(e.voucher_id)) entriesByVoucher.set(e.voucher_id, [])
    entriesByVoucher.get(e.voucher_id)!.push(e)
  }

  // ── Build XML ──────────────────────────────────────────────────────────────
  const messages: string[] = []
  const byNature: Record<string, number> = {}
  let totalDebit = 0

  for (const v of vouchers) {
    const nature  = (v.voucher_type as unknown as { nature: string } | null)?.nature ?? ''
    const vchType = TALLY_VOUCHER_TYPE[nature] ?? nature
    const vEntries = entriesByVoucher.get(v.id) ?? []

    byNature[nature] = (byNature[nature] ?? 0) + 1

    // Resolve party ledger name
    let partyTallyName = ''
    if (v.entity_id) {
      const entityDisplayName = entityMap.get(v.entity_id) ?? ''
      partyTallyName = resolveByName(entityDisplayName)
    }

    // Build entry lines
    const entryLines: string[] = []
    for (const e of vEntries) {
      const ledger = (e.ledger as unknown as { id: string; name: string } | null)
      if (!ledger) continue
      const tallyName  = resolveByName(ledger.name)
      const isDr       = e.entry_type === 'Dr'
      // Tally sign convention:
      //   Dr → ISDEEMEDPOSITIVE=Yes, AMOUNT=negative
      //   Cr → ISDEEMEDPOSITIVE=No,  AMOUNT=positive
      const isDeemedPositive = isDr ? 'Yes' : 'No'
      const amount     = isDr ? -Math.abs(e.amount) : Math.abs(e.amount)
      if (isDr) totalDebit += Math.abs(e.amount)
      const entryNarration = e.narration ? `\n        <NARRATION>${xmlEscape(e.narration)}</NARRATION>` : ''

      entryLines.push(`    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${xmlEscape(tallyName)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${isDeemedPositive}</ISDEEMEDPOSITIVE>
      <AMOUNT>${formatAmount(amount)}</AMOUNT>${entryNarration}
    </ALLLEDGERENTRIES.LIST>`)
    }

    const partyLine = partyTallyName
      ? `\n    <PARTYLEDGERNAME>${xmlEscape(partyTallyName)}</PARTYLEDGERNAME>`
      : ''
    const narrationLine = v.narration
      ? `\n    <NARRATION>${xmlEscape(v.narration)}</NARRATION>`
      : ''

    messages.push(`  <TALLYMESSAGE xmlns:UDF="TallyUDF">
    <VOUCHER VCHTYPE="${xmlEscape(vchType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <DATE>${tallyDate(v.voucher_date)}</DATE>
      <VOUCHERTYPENAME>${xmlEscape(vchType)}</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${xmlEscape(v.voucher_number)}</VOUCHERNUMBER>${partyLine}${narrationLine}
${entryLines.join('\n')}
    </VOUCHER>
  </TALLYMESSAGE>`)
  }

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${xmlEscape(tallyCompanyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${messages.join('\n')}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`

  const manifest: ExportManifest = {
    company_id:      companyId,
    company_code:    tallyCompanyName,
    tally_company:   tallyCompanyName,
    date_from:       dateFrom,
    date_to:         dateTo,
    voucher_count:   vouchers.length,
    by_nature:       byNature,
    ledger_creates:  0,   // future: prepend ledger creation messages
    total_debit_inr: totalDebit,
    generated_at:    new Date().toISOString(),
  }

  return { xml, manifest }
}

// ── Browser download ──────────────────────────────────────────────────────────

export function downloadTallyXML(xml: string, companyCode: string, dateFrom: string, dateTo: string): void {
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `tally_import_${companyCode}_${dateFrom}_to_${dateTo}.xml`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── CSV parser for Tally master list paste ────────────────────────────────────
// Accepts: Name,Parent Group[,Opening Balance]
// Generated by Tally: Gateway → Display More Reports → List of Accounts → Export

export function parseTallyMasterCSV(raw: string): TallyMasterRow[] {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length < 2) return []

  return lines.slice(1).map(line => {
    const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
    const balance = cols[2] ? parseFloat(cols[2].replace(/[₹,\s]/g, '')) || null : null
    return {
      tally_name:      cols[0] ?? '',
      tally_group:     cols[1] || null,
      opening_balance: balance,
    }
  }).filter(r => r.tally_name)
}
