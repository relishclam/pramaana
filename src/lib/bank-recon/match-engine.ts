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
  voucher_number: string | null
  voucher_date: string
  voucher_narration: string   // voucher-level narration fallback
  party_name: string | null
  reference: string | null
  utr_number?: string | null
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

  async function pgPost(path: string, body: unknown, upsert = false): Promise<void> {
    const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      method: 'POST',
      headers: {
        apikey:           serviceKey,
        Authorization:    `Bearer ${serviceKey}`,
        'Content-Type':   'application/json',
        'Accept-Profile': 'pramaana',
        'Content-Profile': 'pramaana',
        // upsert=true → ignore duplicate unique-constraint violations (safe re-run)
        Prefer:           upsert ? 'return=minimal,resolution=ignore-duplicates' : 'return=minimal',
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
    return { exact_matches: 0, fuzzy_matches: 0, ai_matches: 0, utr_matches: 0, unmatched: 0, queries_created: 0 }
  }

  // ── Fetch candidate voucher entries (posted only) ─────────────────────────
  // Date range: min txn_date - 7 days to max txn_date + 7 days
  const dates = txns.map(t => t.txn_date).sort()
  const minDate = subtractDays(dates[0], 7)
  const maxDate = addDays(dates[dates.length - 1], 7)

  // Fetch candidate voucher entries. Entities fetched separately to avoid cross-schema join limits.
  const rawVEsRes = await fetch(`${supabaseUrl}/rest/v1/` +
    `voucher_entries?ledger_id=eq.${ledgerId}&select=id,voucher_id,ledger_id,entry_type,amount,narration,` +
    `vouchers!inner(id,voucher_date,voucher_number,narration,status,company_id,entity_id)` +
    `&vouchers.status=eq.posted&vouchers.company_id=eq.${companyId}` +
    `&vouchers.voucher_date=gte.${minDate}&vouchers.voucher_date=lte.${maxDate}`, {
    headers: {
      apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
      'Accept-Profile': 'pramaana', 'Content-Profile': 'pramaana',
    },
  })
  if (!rawVEsRes.ok) {
    const err = await rawVEsRes.text()
    console.error('[match] voucher fetch failed', rawVEsRes.status, err)
    throw new Error(`Voucher fetch failed ${rawVEsRes.status}: ${err}`)
  }
  const rawVEs = await rawVEsRes.json() as Array<Record<string, unknown>>

  // Flatten nested PostgREST join shape into a typed flat VoucherEntry[]
  const voucherEntries: VoucherEntry[] = rawVEs.map(ve => {
    const v = ve['vouchers'] as Record<string, unknown> | null ?? {}
    return {
      id:                ve['id'] as string,
      voucher_id:        ve['voucher_id'] as string,
      ledger_id:         ve['ledger_id'] as string,
      entry_type:        ve['entry_type'] as 'Dr' | 'Cr',
      amount:            ve['amount'] as number,
      narration:         ve['narration'] as string | null,
      voucher_number:    v['voucher_number'] as string | null,
      voucher_date:      v['voucher_date'] as string,
      voucher_narration: v['narration'] as string ?? '',
      party_name:        null,   // filled by entity lookup below
      reference:         null,
      _entity_id:        v['entity_id'] as string | null,
    } as VoucherEntry & { _entity_id: string | null }
  })
  console.log('[match] candidates loaded:', voucherEntries.length)

  // Fetch party names from registry.entities in a single second query (Tier 3 AI context only)
  const entityIds = [...new Set(
    (voucherEntries as Array<VoucherEntry & { _entity_id: string | null }>)
      .map(ve => ve._entity_id).filter(Boolean) as string[]
  )]
  if (entityIds.length) {
    try {
      const entRes = await fetch(
        `${supabaseUrl}/rest/v1/entities?id=in.(${entityIds.join(',')})&select=id,display_name`, {
          headers: {
            apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
            'Accept-Profile': 'registry',
          },
        }
      )
      if (entRes.ok) {
        const entRows = await entRes.json() as { id: string; display_name: string }[]
        const entMap = new Map(entRows.map(e => [e.id, e.display_name]))
        ;(voucherEntries as Array<VoucherEntry & { _entity_id: string | null }>).forEach(ve => {
          if (ve._entity_id) ve.party_name = entMap.get(ve._entity_id) ?? null
        })
      } else {
        console.error('[match] entity lookup failed', entRes.status)
      }
    } catch (e) {
      console.error('[match] entity lookup error:', e)
    }
  }

  if (!voucherEntries.length) {
    console.log('[match] no candidates — skipping matching tiers')
    const queries = txns.map(txn => ({ company_id: companyId, bank_txn_id: txn.id, query_type: 'bank_orphan', status: 'open' }))
    if (queries.length) await pgPost('recon_queries', queries)
    await pgPatch(`recon_statements?id=eq.${statementId}`, { upload_status: 'matched', updated_at: new Date().toISOString() })
    return { exact_matches: 0, fuzzy_matches: 0, ai_matches: 0, utr_matches: 0, unmatched: txns.length, queries_created: queries.length }
  }

  // ── Unrestricted candidate pool for Tier 1.2 (no date filter) ──
  const refVEsRes = await fetch(
    `${supabaseUrl}/rest/v1/voucher_entries?ledger_id=eq.${ledgerId}` +
    `&select=id,voucher_id,ledger_id,entry_type,amount,narration,vouchers!inner(id,voucher_date,voucher_number,narration,status,company_id,utr_number)` +
    `&vouchers.status=eq.posted&vouchers.company_id=eq.${companyId}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Accept-Profile': 'pramaana', 'Content-Profile': 'pramaana' },
  })
  const refVoucherEntries: VoucherEntry[] = refVEsRes.ok
    ? ((await refVEsRes.json() as Array<Record<string, unknown>>).map(ve => {
        const v = ve['vouchers'] as Record<string, unknown> | null ?? {}
        return {
          id: ve['id'] as string, voucher_id: ve['voucher_id'] as string, ledger_id: ve['ledger_id'] as string,
          entry_type: ve['entry_type'] as 'Dr' | 'Cr', amount: ve['amount'] as number,
          narration: ve['narration'] as string | null, voucher_number: v['voucher_number'] as string | null,
          voucher_date: v['voucher_date'] as string, voucher_narration: v['narration'] as string ?? '',
          party_name: null, reference: null, utr_number: v['utr_number'] as string | null,
        }
      }))
    : []

  // Scope to only the candidate VE IDs to avoid a full-company scan
  const matchedVoucherEntryIds = new Set<string>()
  const allCandidateIds = [
    ...voucherEntries.map(ve => ve.id),
    ...refVoucherEntries.map(ve => ve.id),
  ].filter((id, i, a) => a.indexOf(id) === i)
  if (allCandidateIds.length) {
    const existingMatches = await pgFetch(
      `recon_matches?voucher_entry_id=in.(${allCandidateIds.join(',')})&select=voucher_entry_id`
    ).catch(() => [] as unknown[]) as { voucher_entry_id: string }[]
    existingMatches.forEach(m => { if (m.voucher_entry_id) matchedVoucherEntryIds.add(m.voucher_entry_id) })
  }

  const matchedTxnIds = new Set<string>()

  // ── TIER 0: UTR match ──────────────────────────────────────────────────────
  // Runs first; matched txns/VEs leave the pool before Tier 1.
  const utrMatches: MatchResult[] = []
  const utrIndex = new Map<string, (VoucherEntry & { utr_number?: string | null })[]>()
  for (const ve of refVoucherEntries as Array<VoucherEntry & { utr_number?: string | null }>) {
    if (!ve.utr_number) continue
    const list = utrIndex.get(ve.utr_number) ?? []
    list.push(ve)
    utrIndex.set(ve.utr_number, list)
  }
  for (const txn of txns) {
    const txnAmount = txn.debit ?? txn.credit
    if (txnAmount === null) continue
    const bookSide: 'Dr' | 'Cr' = txn.debit !== null ? 'Cr' : 'Dr'
    // Direct candidates from pre-parsed fields first, then narration tokenization.
    // parsed_reference/reference are already clean refs from the bank statement importer.
    const directCandidates = [txn.parsed_reference, txn.reference]
      .filter((r): r is string => typeof r === 'string' && r.length >= 9 && r.length <= 16 && /^[A-Z0-9]+$/i.test(r))
      .map(r => r.toUpperCase())
    const allCandidates = [...new Set([...directCandidates, ...extractUtrCandidates(txn.narration)])]
    for (const utrToken of allCandidates) {
      const batchVEs = (utrIndex.get(utrToken) ?? []).filter(
        ve => !matchedVoucherEntryIds.has(ve.id) && ve.entry_type === bookSide
      )
      if (!batchVEs.length) continue
      const batchSum = roundMoney(batchVEs.reduce((s, ve) => s + ve.amount, 0))
      if (Math.abs(batchSum - roundMoney(txnAmount)) <= 1) {
        for (const ve of batchVEs) {
          utrMatches.push({
            bank_txn_id: txn.id, voucher_id: ve.voucher_id, voucher_entry_id: ve.id,
            match_method: 'utr', match_confidence: 100,
            match_reason: `UTR ${utrToken} — ${batchVEs.length > 1 ? `${batchVEs.length}-voucher batch` : 'single voucher'} ₹${batchSum}`,
            company_id: companyId,
          })
          matchedVoucherEntryIds.add(ve.id)
        }
        matchedTxnIds.add(txn.id)
        break
      } else {
        // UTR hit but amount sum mismatch — data problem, never a silent skip
        console.error(
          `[UTR-REVIEW] txn=${txn.id} utr=${utrToken} batchVEs=${batchVEs.length}` +
          ` batchSum=₹${batchSum} txnAmount=₹${txnAmount} narration="${txn.narration.slice(0, 80)}"`
        )
      }
    }
  }
  if (utrMatches.length) {
    await pgPost('recon_matches', utrMatches, true)
    const utrTxnIds = [...new Set(utrMatches.map(m => m.bank_txn_id))]
    await pgPatch(`recon_transactions?id=in.(${utrTxnIds.join(',')})`, { match_status: 'auto_matched' })
  }
  console.error(`[T0-UTR] ${utrMatches.length} matches written`)

  // ── TIER 1: Exact match (same date, exact amount, optionally reference) ────
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

  // Insert Tier 1 matches and update statuses BEFORE Tier 1.2
  if (exactMatches.length) {
    await pgPost('recon_matches', exactMatches, true)
    const tier1TxnIds = exactMatches.map(m => m.bank_txn_id)
    await pgPatch(
      `recon_transactions?id=in.(${tier1TxnIds.join(',')})`,
      { match_status: 'auto_matched' }
    )
  }

  // ── TIER 1.2: Narration voucher-reference matching ─────────────────────────
  const refMatches: MatchResult[] = []
  const refTxns = txns.filter(t => !matchedTxnIds.has(t.id))

  for (const txn of refTxns) {
    const amount = txn.debit ?? txn.credit
    if (amount === null) continue
    const bookSide: 'Dr' | 'Cr' = txn.debit !== null ? 'Cr' : 'Dr'
    const refs = extractVoucherRefs(txn.narration)
    if (!refs.length) continue

    const refCandidates = refs.flatMap(ref =>
      refVoucherEntries.filter(ve =>
        !matchedVoucherEntryIds.has(ve.id) &&
        ve.entry_type === bookSide &&
        voucherNumberMatchesRef(ve.voucher_number, ref)
      )
    )
    if (!refCandidates.length) continue

    const uniqueCandidates = refCandidates.filter((ve, i, a) => a.findIndex(x => x.id === ve.id) === i)
    const sumAmt = roundMoney(uniqueCandidates.reduce((s, ve) => s + ve.amount, 0))
    const amountMatches = Math.abs(sumAmt - roundMoney(amount)) < 0.01

    if (amountMatches) {
      for (const ve of uniqueCandidates) {
        refMatches.push({
          bank_txn_id: txn.id, voucher_id: ve.voucher_id, voucher_entry_id: ve.id,
          match_method: 'reference', match_confidence: 97,
          match_reason: `Narration ref matches voucher ${ve.voucher_number ?? ve.voucher_id}; amounts agree ₹${sumAmt}`,
          company_id: companyId,
        })
        matchedVoucherEntryIds.add(ve.id)
      }
      matchedTxnIds.add(txn.id)
    } else if (refs.length === 1 && uniqueCandidates.length === 1) {
      // Explicit single ref, no amount match — bank charge / split-ledger case.
      const ve = uniqueCandidates[0]
      refMatches.push({
        bank_txn_id: txn.id, voucher_id: ve.voucher_id, voucher_entry_id: ve.id,
        match_method: 'reference', match_confidence: 75,
        match_reason: `Narration ref matches voucher ${ve.voucher_number ?? ve.voucher_id}; ledger entry ₹${ve.amount} ≠ bank ₹${amount} (likely split-ledger payment)`,
        company_id: companyId,
      })
      matchedVoucherEntryIds.add(ve.id)
      matchedTxnIds.add(txn.id)
    }
  }

  const refAutoIds   = [...new Set(refMatches.filter(m => m.match_confidence >= 90).map(m => m.bank_txn_id))]
  const refReviewIds = [...new Set(refMatches.filter(m => m.match_confidence  < 90).map(m => m.bank_txn_id))]
  if (refMatches.length) {
    await pgPost('recon_matches', refMatches, true)
    if (refAutoIds.length)   await pgPatch(`recon_transactions?id=in.(${refAutoIds.join(',')})`,   { match_status: 'auto_matched' })
    if (refReviewIds.length) await pgPatch(`recon_transactions?id=in.(${refReviewIds.join(',')})`, { match_status: 'pending_review' })
  }

  // ── TIER 2: Amount match against unrestricted pool (no date wall) ────────
  // FY25-26 vouchers have dates months before FY26-27 bank transactions.
  const tier2Txns = txns.filter(t => !matchedTxnIds.has(t.id))
  for (const txn of tier2Txns) {
    const amount = txn.debit ?? txn.credit
    if (amount === null) continue

    const bookSide: 'Dr' | 'Cr' = txn.debit !== null ? 'Cr' : 'Dr'

    const candidates = refVoucherEntries.filter(ve => {
      if (matchedVoucherEntryIds.has(ve.id)) return false
      if (ve.entry_type !== bookSide) return false
      return Math.abs(roundMoney(ve.amount) - roundMoney(amount)) < 0.01
    })

    if (!candidates.length) continue

    // Score by date proximity + reference; unique-amount match gets higher confidence
    let best = candidates[0]
    let bestScore = 0
    for (const ve of candidates) {
      let score = 70
      const diff = dateDiffDays(txn.txn_date, ve.voucher_date)
      score += diff === 0 ? 20 : diff <= 3 ? 15 : diff <= 14 ? 8 : diff <= 60 ? 4 : 1
      if (refMatch(txn, ve)) score += 10
      if (score > bestScore) { bestScore = score; best = ve }
    }

    const confidence = candidates.length === 1 ? Math.min(bestScore, 94) : Math.min(bestScore - 10, 80)

    fuzzyMatches.push({
      bank_txn_id:      txn.id,
      voucher_id:       best.voucher_id,
      voucher_entry_id: best.id,
      match_method:     'fuzzy',
      match_confidence: confidence,
      match_reason:     `Amount ₹${amount} matches${candidates.length > 1 ? ` (${candidates.length} candidates, best by date)` : ''}, voucher ${best.voucher_number ?? best.voucher_id}`,
      company_id:       companyId,
    })
    matchedVoucherEntryIds.add(best.id)
    matchedTxnIds.add(txn.id)
  }

  if (fuzzyMatches.length) {
    await pgPost('recon_matches', fuzzyMatches, true)
    const t2AutoIds   = fuzzyMatches.filter(m => m.match_confidence >= 85).map(m => m.bank_txn_id)
    const t2ReviewIds = fuzzyMatches.filter(m => m.match_confidence  < 85).map(m => m.bank_txn_id)
    if (t2AutoIds.length)   await pgPatch(`recon_transactions?id=in.(${t2AutoIds.join(',')})`,   { match_status: 'auto_matched' })
    if (t2ReviewIds.length) await pgPatch(`recon_transactions?id=in.(${t2ReviewIds.join(',')})`, { match_status: 'pending_review' })
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
      if (candidates.length > 0) candidateMap.set(txn.id, candidates)
    }

    const tier3WithCandidates = tier3Txns.filter(t => candidateMap.has(t.id))
    if (!tier3WithCandidates.length) {
      console.log('[match] no Tier 3 candidates — skipping AI')
    } else {

    const aiInput = tier3WithCandidates.map(t => ({
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
        await pgPost('recon_matches', aiMatches, true)
        aiMatchCount = aiMatches.length
        await pgPatch(
          `recon_transactions?id=in.(${aiMatches.map(m => m.bank_txn_id).join(',')})`,
          { match_status: 'pending_review' }
        )
      }
    } catch (err) {
      console.error('Tier 3 AI match skipped — Anthropic API unavailable:', err)
    }
    } // end tier3WithCandidates block
  }

  // ── Create queries for genuinely unmatched items ──────────────────────────
  if (matchedTxnIds.size) {
    await pgPatch(
      `recon_queries?bank_txn_id=in.(${[...matchedTxnIds].join(',')})&status=in.(open,investigating)`,
      { status: 'resolved', resolution_note: 'Auto-resolved: matched', resolved_at: new Date().toISOString() }
    ).catch(e => console.error('[match] query resolve error:', e))
  }

  const stillUnmatched = txns.filter(t => !matchedTxnIds.has(t.id))
  if (stillUnmatched.length) {
    const existingQueryTxnIds = new Set<string>()
    try {
      const existing = await pgFetch(
        `recon_queries?bank_txn_id=in.(${stillUnmatched.map(t => t.id).join(',')})&status=in.(open,investigating)&select=bank_txn_id`
      ) as { bank_txn_id: string }[]
      existing.forEach(q => { if (q.bank_txn_id) existingQueryTxnIds.add(q.bank_txn_id) })
    } catch { /* non-fatal */ }
    const newQueries = stillUnmatched
      .filter(t => !existingQueryTxnIds.has(t.id))
      .map(txn => ({ company_id: companyId, bank_txn_id: txn.id, query_type: 'bank_orphan', status: 'open' }))
    if (newQueries.length) await pgPost('recon_queries', newQueries)
    queriesCreated = newQueries.length
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
    utr_matches:   utrMatches.length,
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

function extractVoucherRefs(narration: string): number[] {
  const refs: number[] = []
  const primary = /VCH[-\s]*(?:20\d{2}[-\s]*\d{2}[-\s]*)?0*(\d{1,5})/gi
  let m: RegExpExecArray | null
  while ((m = primary.exec(narration)) !== null) {
    refs.push(parseInt(m[1], 10))
    let tail = narration.slice(primary.lastIndex)
    let extra: RegExpExecArray | null
    const trailingNum = /^[-\s]+0*(\d{1,5})(?=\s|$|[^\d])/
    while ((extra = trailingNum.exec(tail)) !== null) {
      const n = parseInt(extra[1], 10)
      if (n >= 100) refs.push(n)   // skip single/double-digit trailing noise
      tail = tail.slice(extra[0].length)
    }
  }
  // Fallback: bare OTH-NNN without a preceding VCH token (e.g. "OTH-421")
  if (!refs.length) {
    const othPattern = /\bOTH-0*(\d{3,5})\b/gi
    let om: RegExpExecArray | null
    while ((om = othPattern.exec(narration)) !== null) refs.push(parseInt(om[1], 10))
  }
  return [...new Set(refs)]
}

// Matches both VCH-YYYY-YY-NNNNN (dash+5-digit) and RFPL/PYMT/YYYY/NNNN (slash+4-digit) series.
function voucherNumberMatchesRef(voucherNumber: string | null, ref: number): boolean {
  if (!voucherNumber) return false
  const raw = String(ref)
  const padded5 = raw.padStart(5, '0')
  const padded4 = raw.padStart(4, '0')
  return (
    voucherNumber.endsWith('-' + padded5) ||
    voucherNumber.endsWith('-' + raw) ||
    voucherNumber.endsWith('/' + padded4) ||
    voucherNumber.endsWith('/' + raw)
  )
}

// Extract UTR candidate tokens from a bank narration.
// Tokens: 9–16 chars, uppercase alphanumeric (A-Z + 0-9), must contain ≥1 digit.
// Returned as strings — never cast to integer; preserves leading zeros.
function extractUtrCandidates(narration: string): string[] {
  return [...new Set(
    narration.toUpperCase().split(/[^A-Z0-9]/).filter(
      t => t.length >= 9 && t.length <= 16 && /^[A-Z0-9]+$/.test(t) && /[0-9]/.test(t)
    )
  )]
}
