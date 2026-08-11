#!/usr/bin/env tsx
/**
 * upload_hdfc_statements.ts
 * Uploads HDFC RHHF bank statements directly — bypasses the HTTP API layer.
 * Replicates the full pipeline: pre-converter → commit → match engine.
 *
 * Usage:
 *   npx tsx scripts/upload_hdfc_statements.ts
 */

import { readFileSync, existsSync } from 'fs'
import { createHash }   from 'crypto'
import { runPreConverter } from '../api/lib/bank-recon/pre-converter.js'
import { runMatchEngine }  from '../api/lib/bank-recon/match-engine.js'
import { parseNarration }  from '../api/lib/bank-recon/narration-parser.js'
import type { ColumnMapping, PreConvertResult } from '../api/lib/bank-recon/types.js'

// Load .env from repo root — avoids ESM dotenv resolution issues
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
const __dir = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dir, '..', '.env')
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const idx = line.indexOf('=')
    if (idx < 1 || line.trimStart().startsWith('#')) continue
    const k = line.slice(0, idx).trim()
    let v = line.slice(idx + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (k && !(k in process.env)) process.env[k] = v
  }
}

const URL_  = process.env['PM_SUPABASE_URL']!
const KEY   = process.env['PM_SERVICE_ROLE_KEY']!
const RHHF  = process.env['PM_RHHF_COMPANY_ID']!
// Use RHHF admin user (valid in Pramaana auth.users); migration user is RA-only
const SYSUID = '03a52c2c-d660-40f0-9378-3c82b40fe98a'

const FILES = [
  { path: 'C:\\Users\\user\\Downloads\\Acct_Statement_XXXXXXXX1702_11082026.xls', label: 'HDFC No-Lien (...1702)' },
  { path: 'C:\\Users\\user\\Downloads\\Acct_Statement_XXXXXXXX2324_11082026.xls', label: 'HDFC Current (...2324)' },
]

// ── DB helpers ────────────────────────────────────────────────────────────────

async function dbGet(path: string, schema = 'pramaana'): Promise<unknown[]> {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Accept-Profile': schema },
  })
  if (!res.ok) { console.error('GET', path, res.status, await res.text()); return [] }
  return res.json() as Promise<unknown[]>
}

async function dbPost(path: string, body: unknown, schema = 'pramaana'): Promise<{ id: string }[]> {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) { const e = await res.text(); throw new Error(`POST ${path} ${res.status}: ${e}`) }
  return res.json() as Promise<{ id: string }[]>
}

async function dbPatch(path: string, body: unknown, schema = 'pramaana'): Promise<void> {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) console.error('PATCH', path, res.status, await res.text())
}

// ── Bank account upsert ───────────────────────────────────────────────────────

async function upsertBankAccount(bankCode: string, bankName: string, accountNumber: string, ifsc: string | null) {
  const existing = (await dbGet(
    `recon_bank_accounts?company_id=eq.${RHHF}&bank_code=eq.${encodeURIComponent(bankCode)}&account_number=eq.${encodeURIComponent(accountNumber)}&select=id,ledger_id`
  )) as { id: string; ledger_id: string | null }[]
  if (existing.length) return existing[0]

  const [created] = await dbPost('recon_bank_accounts', {
    company_id: RHHF, bank_code: bankCode, bank_name: bankName,
    account_number: accountNumber, ifsc: ifsc ?? null,
    currency: 'INR', is_active: true,
  })
  console.log(`  Created new bank account ${bankCode}/${accountNumber}: ${created.id}`)
  return { id: created.id, ledger_id: null as string | null }
}

// ── Format profile upsert ─────────────────────────────────────────────────────

async function upsertFormatProfile(bankCode: string, signature: string, mapping: unknown, headerRow: string[], method: string) {
  const existing = (await dbGet(
    `recon_format_profiles?bank_code=eq.${encodeURIComponent(bankCode)}&format_signature=eq.${encodeURIComponent(signature)}&select=id`
  )) as { id: string }[]
  if (existing.length) {
    await dbPatch(`recon_format_profiles?bank_code=eq.${encodeURIComponent(bankCode)}&format_signature=eq.${encodeURIComponent(signature)}`,
      { last_used_at: new Date().toISOString() })
    return existing[0].id
  }
  const [created] = await dbPost('recon_format_profiles', {
    bank_code: bankCode, format_signature: signature,
    column_mapping: mapping,
    sample_headers: headerRow.filter(h => h.trim().length > 0),
    detection_method: method,
  })
  return created.id
}

// ── Check for existing statement overlap ──────────────────────────────────────

async function checkOverlap(bankAccountId: string, periodFrom: string, periodTo: string) {
  const rows = (await dbGet(
    `recon_statements?bank_account_id=eq.${bankAccountId}&period_from=lte.${periodTo}&period_to=gte.${periodFrom}&select=id,period_from,period_to`
  )) as { id: string; period_from: string; period_to: string }[]
  return rows
}

// ── Commit statement + transactions ──────────────────────────────────────────

async function commitStatement(pre: PreConvertResult, bankAccountId: string, profileId: string | null, fileHash: string, fileName: string): Promise<string> {
  const v = pre.validation
  const [stmt] = await dbPost('recon_statements', {
    company_id:       RHHF,
    bank_account_id:  bankAccountId,
    period_from:      pre.period_from,
    period_to:        pre.period_to,
    opening_balance:  pre.opening_balance,
    closing_balance:  pre.closing_balance,
    total_debits:     v.total_debits,
    total_credits:    v.total_credits,
    txn_count:        pre.transactions.length,
    debit_count:      pre.transactions.filter(t => t.debit !== null).length,
    credit_count:     pre.transactions.filter(t => t.credit !== null).length,
    sort_order:       pre.sort_detected,
    format_profile_id: profileId,
    file_name:        fileName,
    file_hash:        fileHash,
    storage_path:     `scripts-upload/${fileHash.slice(0, 16)}`,
    upload_status:    'parsed',
    uploaded_by:      SYSUID,
  })

  const statementId = stmt.id
  const CHUNK = 500
  for (let i = 0; i < pre.transactions.length; i += CHUNK) {
    const chunk = pre.transactions.slice(i, i + CHUNK).map(t => {
      const parsed = parseNarration(t.narration)
      return {
        statement_id:         statementId,
        company_id:           RHHF,
        bank_account_id:      bankAccountId,
        row_number:           t.row_number,
        txn_date:             t.txn_date,
        value_date:           t.value_date,
        narration:            t.narration,
        reference:            t.reference,
        debit:                t.debit,
        credit:               t.credit,
        balance:              t.balance,
        match_status:         'unmatched',
        txn_type:             parsed.txn_type,
        counterparty:         parsed.counterparty,
        counterparty_account: parsed.counterparty_account,
        parsed_reference:     parsed.parsed_reference,
        parsed_purpose:       parsed.parsed_purpose,
        is_charge:            parsed.is_charge,
        is_reversal:          parsed.is_reversal,
      }
    })
    await dbPost('recon_transactions', chunk)
  }
  return statementId
}

// ── Spot-check Tier 0 matches ─────────────────────────────────────────────────

async function spotCheckTier0(statementId: string, n = 5) {
  const matches = (await dbGet(
    `recon_matches?match_method=eq.utr&select=bank_txn_id,voucher_id,match_confidence,match_reason&order=match_confidence.desc&limit=${n * 3}`
  )) as { bank_txn_id: string; voucher_id: string; match_confidence: number; match_reason: string }[]

  // filter to this statement's txns
  const txns = (await dbGet(
    `recon_transactions?statement_id=eq.${statementId}&match_status=eq.auto_matched&match_method=not.is.null&select=id,narration,reference,parsed_reference,debit,credit&limit=50`
  )) as { id: string; narration: string; reference: string | null; parsed_reference: string | null; debit: number | null; credit: number | null }[]

  const txnIds = new Set(txns.map(t => t.id))
  const stmtMatches = matches.filter(m => txnIds.has(m.bank_txn_id)).slice(0, n)

  if (!stmtMatches.length) {
    // try via join
    const stmtT0 = (await dbGet(
      `recon_transactions?statement_id=eq.${statementId}&match_status=eq.auto_matched&select=id,narration,reference,parsed_reference,debit,credit&limit=${n}`
    )) as { id: string; narration: string; reference: string | null; parsed_reference: string | null; debit: number | null; credit: number | null }[]

    console.log(`  Spot check: ${stmtT0.length} auto_matched txns found (checking matches table)`)
    for (const t of stmtT0.slice(0, n)) {
      const m = (await dbGet(`recon_matches?bank_txn_id=eq.${t.id}&select=voucher_id,match_method,match_confidence,match_reason`)) as { voucher_id: string; match_method: string; match_confidence: number; match_reason: string }[]
      if (!m.length) continue
      const v = (await dbGet(`vouchers?id=eq.${m[0].voucher_id}&select=voucher_number,utr_number,amount`)) as { voucher_number: string; utr_number: string; amount: number }[]
      const amt = t.debit ?? t.credit
      const vv = v[0]
      console.log(`  Bank: ref=${t.reference ?? t.parsed_reference ?? 'n/a'}  amt=${amt}  narration="${t.narration.slice(0, 50)}"`)
      console.log(`    -> ${m[0].match_method} conf=${m[0].match_confidence}  voucher=${vv?.voucher_number}  utr=${vv?.utr_number}  vamt=${vv?.amount}`)
      console.log(`       reason: ${m[0].match_reason}`)
    }
    return
  }

  const txnMap = new Map(txns.map(t => [t.id, t]))
  for (const m of stmtMatches) {
    const t = txnMap.get(m.bank_txn_id)
    const v = (await dbGet(`vouchers?id=eq.${m.voucher_id}&select=voucher_number,utr_number,amount`)) as { voucher_number: string; utr_number: string; amount: number }[]
    const amt = t ? (t.debit ?? t.credit) : '?'
    const vv = v[0]
    console.log(`  Bank: ref=${t?.reference ?? t?.parsed_reference ?? 'n/a'}  amt=${amt}  narration="${t?.narration.slice(0, 50)}"`)
    console.log(`    -> conf=${m.match_confidence}  voucher=${vv?.voucher_number}  utr=${vv?.utr_number}  vamt=${vv?.amount}`)
    console.log(`       reason: ${m.match_reason}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function processFile(filePath: string, label: string) {
  console.log(`\n${'='.repeat(70)}`)
  console.log(`PROCESSING: ${label}`)
  console.log(`File: ${filePath}`)
  console.log('='.repeat(70))

  const rawBytes = new Uint8Array(readFileSync(filePath))
  const fileName = filePath.split('\\').pop()!
  const fileHash = createHash('sha256').update(rawBytes).digest('hex')

  // Duplicate check
  const dupCheck = (await dbGet(`recon_statements?company_id=eq.${RHHF}&file_hash=eq.${fileHash}&select=id`)) as { id: string }[]
  if (dupCheck.length) {
    console.log(`  SKIP: Already uploaded as statement ${dupCheck[0].id}`)
    return dupCheck[0].id
  }

  // ── Pre-converter ──────────────────────────────────────────────────────────
  console.log('\n[1] Running pre-converter...')
  const pre = await runPreConverter(rawBytes, fileName)

  const m = pre.format.mapping as ColumnMapping
  console.log(`  Bank detected  : ${pre.bank.bank_name} (${pre.bank.bank_code}) — confidence ${pre.bank.confidence}% via ${pre.bank.method}`)
  console.log(`  Account number : ${pre.bank.account_number ?? 'not detected'}`)
  console.log(`  Format method  : ${pre.format.method}`)
  console.log(`  Period         : ${pre.period_from} → ${pre.period_to}  (${pre.sort_detected} sort)`)
  console.log(`  Transactions   : ${pre.transactions.length}  (${pre.transactions.filter(t=>t.debit!==null).length} debit / ${pre.transactions.filter(t=>t.credit!==null).length} credit)`)
  console.log(`  Balance OK     : ${pre.validation.is_valid}  (open=${pre.opening_balance} close=${pre.closing_balance})`)
  console.log(`  Duplicates     : ${pre.duplicates.length} groups`)
  console.log(`\n  Column mapping:`)
  console.log(`    date_col       : ${m.date_col}  (format: ${m.date_format})`)
  console.log(`    narration_col  : ${m.narration_col}`)
  console.log(`    reference_col  : ${m.reference_col ?? 'null'} ← Chq./Ref.No. should be here`)
  console.log(`    debit_col      : ${m.debit_col ?? 'null'}`)
  console.log(`    credit_col     : ${m.credit_col ?? 'null'}`)
  console.log(`    balance_col    : ${m.balance_col}`)
  console.log(`    header_row     : ${m.header_row}  data_start_row: ${m.data_start_row}`)

  // Spot: verify reference column is populated
  const sampleRefs = pre.transactions.slice(0, 20).map(t => t.reference).filter(Boolean)
  console.log(`\n  Sample references (first 20 txns): [${sampleRefs.slice(0,5).join(', ')}]  (${sampleRefs.length}/20 populated)`)

  // ── Bank account ───────────────────────────────────────────────────────────
  console.log('\n[2] Upserting bank account...')
  const bankAccount = await upsertBankAccount(
    pre.bank.bank_code, pre.bank.bank_name,
    pre.bank.account_number ?? 'UNKNOWN', pre.bank.ifsc,
  )
  console.log(`  bank_account_id: ${bankAccount.id}  ledger_id: ${bankAccount.ledger_id ?? 'NOT LINKED'}`)

  // ── Overlap check ──────────────────────────────────────────────────────────
  console.log('\n[3] Checking overlap...')
  const overlaps = await checkOverlap(bankAccount.id, pre.period_from, pre.period_to)
  if (overlaps.length) {
    console.log(`  Overlap with existing statement(s): ${overlaps.map(o => `${o.id} (${o.period_from}→${o.period_to})`).join(', ')}`)
    console.log(`  Using skip_duplicates strategy — filtering already-ingested rows`)
    const existing = (await dbGet(
      `recon_transactions?bank_account_id=eq.${bankAccount.id}&txn_date=gte.${pre.period_from}&txn_date=lte.${pre.period_to}&select=txn_date,debit,credit,narration`
    )) as { txn_date: string; debit: number | null; credit: number | null; narration: string }[]
    const existingKeys = new Set(existing.map(e => `${e.txn_date}|${e.debit}|${e.credit}|${e.narration}`))
    const before = pre.transactions.length
    pre.transactions = pre.transactions.filter(t => !existingKeys.has(`${t.txn_date}|${t.debit}|${t.credit}|${t.narration}`))
    console.log(`  Filtered ${before - pre.transactions.length} duplicate txns → ${pre.transactions.length} new to insert`)
    if (!pre.transactions.length) { console.log('  All transactions already exist — nothing to insert'); return '' }
  } else {
    console.log('  No overlap — clean insert')
  }

  // ── Format profile ─────────────────────────────────────────────────────────
  const profileId = await upsertFormatProfile(
    pre.bank.bank_code, pre.format.format_signature,
    pre.format.mapping,
    pre.raw_rows[m.header_row] ?? [],
    pre.format.method === 'ai' ? 'ai' : 'heuristic',
  )

  // ── Commit ─────────────────────────────────────────────────────────────────
  console.log(`\n[4] Committing ${pre.transactions.length} transactions...`)
  const statementId = await commitStatement(pre, bankAccount.id, profileId, fileHash, fileName)
  console.log(`  statement_id: ${statementId}`)

  // ── Match engine ───────────────────────────────────────────────────────────
  console.log('\n[5] Running match engine...')
  if (!bankAccount.ledger_id) {
    console.log('  WARNING: bank_account.ledger_id is NULL — match engine skipped')
    console.log('  The recon_bank_accounts row needs to be linked to a pramaana.ledgers row.')
    return statementId
  }

  const match = await runMatchEngine(statementId, RHHF, bankAccount.ledger_id, URL_, KEY)
  console.log(`\n  MATCH RESULTS:`)
  console.log(`    Tier 0 (UTR)    : ${match.utr_matches}`)
  console.log(`    Tier 1 (exact)  : ${match.exact_matches}`)
  console.log(`    Tier 2 (fuzzy)  : ${match.fuzzy_matches}`)
  console.log(`    Tier 3 (AI)     : ${match.ai_matches}`)
  console.log(`    Orphans         : ${match.unmatched}  (queries_created: ${match.queries_created})`)
  const matched = match.utr_matches + match.exact_matches + match.fuzzy_matches + match.ai_matches
  const total   = pre.transactions.length
  console.log(`    Match rate      : ${matched}/${total} = ${((matched/total)*100).toFixed(1)}%`)

  // ── Spot checks ────────────────────────────────────────────────────────────
  if (match.utr_matches > 0 && label.includes('1702')) {
    console.log(`\n[6] Spot-checking 5 Tier 0 matches (UTR chain verification)...`)
    await spotCheckTier0(statementId, 5)
  }

  return statementId
}

// ── Run match engine on already-committed statements ─────────────────────────
// Called separately after reassigning bank_account_id

async function runMatchOnStatements() {
  const RUNS = [
    { label: 'HDFC No-Lien (...1702)', stmtId: 'd26cd88d-bb61-4b7a-810a-1a126c77d449', ledgerId: 'c4c1bed5-3d42-4942-91c9-92abc72596a4', txns: 804 },
    { label: 'HDFC Current (...2324)', stmtId: '5a0b14b6-0327-4f5f-a280-49ce1d4f9052', ledgerId: 'f631b55b-3552-4689-b2b9-1f426d8ac5d9', txns: 18  },
  ]
  for (const r of RUNS) {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`MATCH ENGINE: ${r.label}`)
    const result = await runMatchEngine(r.stmtId, RHHF, r.ledgerId, URL_, KEY)
    const matched = result.utr_matches + result.exact_matches + result.fuzzy_matches + result.ai_matches
    console.log(`  Tier 0 (UTR)   : ${result.utr_matches}`)
    console.log(`  Tier 1 (exact) : ${result.exact_matches}`)
    console.log(`  Tier 2 (fuzzy) : ${result.fuzzy_matches}`)
    console.log(`  Tier 3 (AI)    : ${result.ai_matches}`)
    console.log(`  Orphans        : ${result.unmatched}  (queries: ${result.queries_created})`)
    console.log(`  Match rate     : ${matched}/${r.txns} = ${((matched/r.txns)*100).toFixed(1)}%`)

    if (result.utr_matches > 0 && r.label.includes('1702')) {
      console.log(`\n  Spot-checking 5 Tier 0 matches...`)
      await spotCheckTier0(r.stmtId, 5)
    }
  }
}

await runMatchOnStatements()
