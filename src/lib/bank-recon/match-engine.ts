// ── Three-Tier Match Engine ───────────────────────────────────────────────────
// Server-side only.  Each tier updates match_status BEFORE the next tier runs
// to prevent UNIQUE(bank_txn_id) violations on recon_matches.

import { aiSuggestMatches } from './ai-match-suggest'
import { roundMoney } from './number-utils'
import type { MatchResult, MatchEngineResult } from './types'

// Minimal Supabase client interface to keep this file portable
interface DbClient {
  from: (table: string) => {
    select: (cols: string) => {
      eq:  (col: string, val: string) => Promise<{ data: unknown[] | null; error: unknown }>
      in:  (col: string, vals: string[]) => Promise<{ data: unknown[] | null; error: unknown }>
    }
    insert: (rows: unknown) => Promise<{ error: unknown }>
    update: (data: unknown) => { eq: (c: string, v: string) => { in?: (c2: string, v2: string[]) => Promise<{ error: unknown }> }; in: (c: string, v: string[]) => Promise<{ error: unknown }> }
    rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>
  }
}

interface ReconTransaction {
  id: string
  company_id: string
  bank_account_id: string
  txn_date: string
  debit: number | null
  credit: number | null
  narration: string
  reference: string | null
  counterparty: string | null
  parsed_reference: string | null
  match_status: string
}

interface VoucherEntry {
  id: string
  voucher_id: string
  ledger_id: string
  // entry_type canonical casing in DB: exactly 'Dr' or 'Cr' (no normalisation needed)
  entry_type: 'Dr' | 'Cr'
  amount: number
  narration: string | null    // entry-level narration; may be null
  voucher_date: string
  voucher_narration: string   // voucher-level narration fallback
  party_name: string | null
  reference: string | null
}

export async function runMatchEngine(
  statementId: string,
  companyId: string,
  ledgerId: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<MatchEngineResult> {

  const exactMatches: MatchResult[] = []
  const fuzzyMatches: MatchResult[] = []
  let aiMatchCount = 0
  let queriesCreated = 0

  // ── Helper: raw fetch to Supabase REST (Edge-compatible, no SDK needed) ────
  async function pgFetch(path: string, opts: RequestInit = {}): Promise<unknown[]> {
    const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      ...opts,
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Accept-Profile': 'pramaana',
        'Content-Profile': 'pramaana',
        Prefer:         'return=representation',
        ...(opts.headers ?? {}),
      },
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`DB error ${res.status}: ${err}`)
    }
    return res.json() as Promise<unknown[]>
  }

  async function pgPost(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      method: 'POST',
      headers: {
        apikey:           serviceKey,
        Authorization:    `Bearer ${serviceKey}`,
        'Content-Type':   'application/json',
        'Accept-Profile': 'pramaana',
        'Content-Profile': 'pramaana',
        Prefer:           'return=minimal',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`DB insert error ${res.status}: ${err}`)
    }
  }

  async function pgPatch(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      method: 'PATCH',
      headers: {
        apikey:           serviceKey,
        Authorization:    `Bearer ${serviceKey}`,
        'Content-Type':   'application/json',
        'Accept-Profile': 'pramaana',
        'Content-Profile': 'pramaana',
        Prefer:           'return=minimal',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`DB patch error ${res.status}: ${err}`)
    }
  }

  // ── Load unmatched transactions for this statement ────────────────────────
  // Also include pending_review so re-runs don't ignore Tier 2/3 candidates
  const txns = await pgFetch(
    `recon_transactions?statement_id=eq.${statementId}&match_status=in.(unmatched,pending_review)&select=*`
  ) as ReconTransaction[]

  if (!txns.length) {
    return { exact_matches: 0, fuzzy_matches: 0, ai_matches: 0, unmatched: 0, queries_created: 0 }
  }

  // ── Fetch candidate voucher entries (posted only) ─────────────────────────
  // Date range: min txn_date - 7 days to max txn_date + 7 days
  const dates = txns.map(t => t.txn_date).sort()
  const minDate = subtractDays(dates[0], 7)
  const maxDate = addDays(dates[dates.length - 1], 7)

  // Fetch candidate voucher entries. PostgREST returns nested `vouchers` object — flatten below.
  const rawVEs = await pgFetch(
    `voucher_entries?ledger_id=eq.${ledgerId}&select=id,voucher_id,ledger_id,entry_type,amount,narration,` +
    `vouchers!inner(id,voucher_date,narration,status,company_id,entity_id,` +
    `entities:entity_id(display_name))` +
    `&vouchers.status=eq.posted&vouchers.company_id=eq.${companyId}` +
    `&vouchers.voucher_date=gte.${minDate}&vouchers.voucher_date=lte.${maxDate}`
  ).catch(() => [] as unknown[]) as Array<Record<string, unknown>>

  // Flatten nested PostgREST join shape into a typed flat VoucherEntry[]
  const voucherEntries: VoucherEntry[] = rawVEs.map(ve => {
    const v = ve['vouchers'] as Record<string, unknown> | null ?? {}
    const entity = v['entities'] as Record<string, unknown> | null
    return {
      id:                ve['id'] as string,
      voucher_id:        ve['voucher_id'] as string,
      ledger_id:         ve['ledger_id'] as string,
      entry_type:        ve['entry_type'] as 'Dr' | 'Cr',
      amount:            ve['amount'] as number,
      narration:         ve['narration'] as string | null,
      voucher_date:      v['voucher_date'] as string,
      voucher_narration: v['narration'] as string ?? '',
      party_name:        entity ? (entity['display_name'] as string | null) : null,
      reference:         null,
    }
  })

  // Scope to only the candidate VE IDs to avoid a full-company scan
  const matchedVoucherEntryIds = new Set<string>()
  const candidateVeIds = voucherEntries.map(ve => ve.id)
  if (candidateVeIds.length) {
    const existingMatches = await pgFetch(
      `recon_matches?voucher_entry_id=in.(${candidateVeIds.join(',')})&select=voucher_entry_id`
    ).catch(() => [] as unknown[]) as { voucher_entry_id: string }[]
    existingMatches.forEach(m => { if (m.voucher_entry_id) matchedVoucherEntryIds.add(m.voucher_entry_id) })
  }

  // ── TIER 1: Exact match (same date, exact amount, optionally reference) ────
  const matchedTxnIds = new Set<string>()

  for (const txn of txns) {
    const amount = txn.debit ?? txn.credit
    if (amount === null) continue

    // bank debit (out) → book 'Cr' on bank ledger; bank credit (in) → book 'Dr'
    const bookSide: 'Dr' | 'Cr' = txn.debit !== null ? 'Cr' : 'Dr'

    const candidates = voucherEntries.filter(ve => {
      if (matchedVoucherEntryIds.has(ve.id)) return false
      if (ve.entry_type !== bookSide) return false
      if (Math.abs(roundMoney(ve.amount) - roundMoney(amount)) >= 0.01) return false
      if (ve.voucher_date !== txn.txn_date) return false
      return true
    })

    if (!candidates.length) continue

    // Pick best: prefer reference match
    const best = candidates.reduce((a, b) => {
      const aRef = refMatch(txn, a)
      const bRef = refMatch(txn, b)
      return bRef > aRef ? b : a
    })

    const confidence = refMatch(txn, best) ? 100 : 95

    exactMatches.push({
      bank_txn_id:      txn.id,
      voucher_id:       best.voucher_id,
      voucher_entry_id: best.id,
      match_method:     'exact',
      match_confidence: confidence,
      match_reason:     `Exact amount ₹${amount} on ${txn.txn_date}`,
      company_id:       companyId,
    })
    matchedVoucherEntryIds.add(best.id)
    matchedTxnIds.add(txn.id)
  }

  // Insert Tier 1 matches and update statuses BEFORE Tier 2
  if (exactMatches.length) {
    await pgPost('recon_matches', exactMatches)
    const tier1TxnIds = exactMatches.map(m => m.bank_txn_id)
    await pgPatch(
      `recon_transactions?id=in.(${tier1TxnIds.join(',')})`,
      { match_status: 'auto_matched' }
    )
  }

  // ── TIER 2: Fuzzy match (exact amount, ±3 days) ───────────────────────────
  const tier2Txns = txns.filter(t => !matchedTxnIds.has(t.id))
  for (const txn of tier2Txns) {
    const amount = txn.debit ?? txn.credit
    if (amount === null) continue

    const bookSide: 'Dr' | 'Cr' = txn.debit !== null ? 'Cr' : 'Dr'

    const candidates = voucherEntries.filter(ve => {
      if (matchedVoucherEntryIds.has(ve.id)) return false
      if (ve.entry_type !== bookSide) return false
      if (Math.abs(roundMoney(ve.amount) - roundMoney(amount)) >= 0.01) return false
      const diff = dateDiffDays(txn.txn_date, ve.voucher_date)
      return diff <= 3
    })

    if (!candidates.length) continue

    // Score each candidate
    let best = candidates[0]
    let bestScore = 0
    for (const ve of candidates) {
      let score = 70
      const diff = dateDiffDays(txn.txn_date, ve.voucher_date)
      score += diff === 0 ? 10 : diff === 1 ? 7 : diff === 2 ? 4 : 0
      if (refMatch(txn, ve)) score += 10
      if (score > bestScore) { bestScore = score; best = ve }
    }
    if (bestScore < 70) continue

    fuzzyMatches.push({
      bank_txn_id:      txn.id,
      voucher_id:       best.voucher_id,
      voucher_entry_id: best.id,
      match_method:     'fuzzy',
      match_confidence: Math.min(bestScore, 94),
      match_reason:     `Fuzzy match — amount ₹${amount}, date diff ${dateDiffDays(txn.txn_date, best.voucher_date)}d`,
      company_id:       companyId,
    })
    matchedVoucherEntryIds.add(best.id)
    matchedTxnIds.add(txn.id)
  }

  // Insert Tier 2; set pending_review so re-runs don't reprocess them in Tier 3
  if (fuzzyMatches.length) {
    await pgPost('recon_matches', fuzzyMatches)
    const tier2TxnIds = fuzzyMatches.map(m => m.bank_txn_id)
    await pgPatch(
      `recon_transactions?id=in.(${tier2TxnIds.join(',')})`,
      { match_status: 'pending_review' }
    )
  }

  // ── TIER 3: AI match ──────────────────────────────────────────────────────
  const tier3Txns = tier2Txns.filter(t => !matchedTxnIds.has(t.id))
  if (tier3Txns.length) {
    const candidateMap = new Map<string, typeof voucherEntries[number][]>()
    for (const txn of tier3Txns) {
      const amount = txn.debit ?? txn.credit
      if (amount === null) continue
      const bookSide: 'Dr' | 'Cr' = txn.debit !== null ? 'Cr' : 'Dr'
      const candidates = voucherEntries.filter(ve => {
        if (matchedVoucherEntryIds.has(ve.id)) return false
        if (ve.entry_type !== bookSide) return false
        const diff = Math.abs(roundMoney(ve.amount) - roundMoney(amount)) / roundMoney(amount)
        const dateDiff = dateDiffDays(txn.txn_date, ve.voucher_date)
        return diff <= 0.1 && dateDiff <= 7
      }).slice(0, 5)
      candidateMap.set(txn.id, candidates)
    }

    const aiInput = tier3Txns.map(t => ({
      id:        t.id,
      txn_date:  t.txn_date,
      debit:     t.debit,
      credit:    t.credit,
      narration: t.narration,
      reference: t.reference,
    }))

    const aiCandidateMap = new Map(
      [...candidateMap.entries()].map(([k, ves]) => [k, ves.map(ve => ({
        voucher_id:   ve.voucher_id,
        voucher_date: ve.voucher_date,
        amount:       ve.amount,
        party_name:   ve.party_name ?? '',
        narration:    ve.narration ?? ve.voucher_narration ?? '',
      }))])
    )

    try {
      const aiSuggestions = await aiSuggestMatches(aiInput, aiCandidateMap)
      const aiMatches: MatchResult[] = []

      for (const sug of aiSuggestions) {
        if (!sug.voucher_id || sug.confidence < 50) continue
        // Guard: AI may hallucinate a plausible-looking UUID — only accept if it's an actual candidate
        const ve = voucherEntries.find(v => v.voucher_id === sug.voucher_id)
        if (!ve || matchedVoucherEntryIds.has(ve.id)) continue
        aiMatches.push({
          bank_txn_id:      sug.bank_txn_id,
          voucher_id:       sug.voucher_id,
          voucher_entry_id: ve.id,
          match_method:     'ai',
          match_confidence: sug.confidence,
          match_reason:     sug.reason,
          company_id:       companyId,
        })
        matchedVoucherEntryIds.add(ve.id)
        matchedTxnIds.add(sug.bank_txn_id)
      }

      if (aiMatches.length) {
        await pgPost('recon_matches', aiMatches)
        aiMatchCount = aiMatches.length
        await pgPatch(
          `recon_transactions?id=in.(${aiMatches.map(m => m.bank_txn_id).join(',')})`,
          { match_status: 'pending_review' }
        )
      }
    } catch (err) {
      console.error('Tier 3 AI match skipped — Anthropic API unavailable:', err)
    }
  }

  // ── Create queries for genuinely unmatched items ──────────────────────────
  const stillUnmatched = txns.filter(t => !matchedTxnIds.has(t.id))
  if (stillUnmatched.length) {
    const queries = stillUnmatched.map(txn => ({
      company_id:  companyId,
      bank_txn_id: txn.id,
      query_type:  'bank_orphan',
      status:      'open',
    }))
    await pgPost('recon_queries', queries)
    queriesCreated = queries.length
  }

  // ── Update statement status ───────────────────────────────────────────────
  await pgPatch(
    `recon_statements?id=eq.${statementId}`,
    { upload_status: 'matched', updated_at: new Date().toISOString() }
  )

  return {
    exact_matches: exactMatches.length,
    fuzzy_matches: fuzzyMatches.length,
    ai_matches:    aiMatchCount,
    unmatched:     stillUnmatched.length,
    queries_created: queriesCreated,
  }
}

// ── Date math helpers (no external dependencies) ─────────────────────────────

function subtractDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function dateDiffDays(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00Z').getTime()
  const db = new Date(b + 'T00:00:00Z').getTime()
  return Math.abs(Math.round((da - db) / 86400000))
}

// Require minimum 6 chars to avoid false positives on short numeric fragments
function refMatch(txn: ReconTransaction, ve: VoucherEntry): boolean {
  const r1 = txn.parsed_reference ?? txn.reference
  const r2 = ve.reference
  if (!r1 || !r2) return false
  if (r1.length < 6 || r2.length < 6) return r1 === r2
  return r1.includes(r2) || r2.includes(r1)
}
