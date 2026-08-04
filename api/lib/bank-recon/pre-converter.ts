// ── Pre-Converter Pipeline — pure, no DB calls ────────────────────────────────
// Stages: file-type → extract → header-detect → bank-detect → column-map →
//         data-clean → sort-detect → balance-derive → dedup → (overlap — caller)

import { parseCSV, looksLikeCSV, decodeText } from './csv-parser.js'
import { parseXLSX } from './xlsx-parser.js'
import { detectBank, findHeaderRow } from './bank-detect.js'
import { detectColumns, computeFormatSignature } from './format-detect.js'
import { aiDetectFormat } from './ai-format-detect.js'
import { normaliseDate }  from './date-utils.js'
import { stripExcelQuoting, parseAmount, roundMoney } from './number-utils.js'
import { deriveOpeningBalance, validateBalanceContinuity, detectSortOrder } from './balance-validator.js'
import { GLOBAL_SKIP_PATTERNS, BANK_SIGNATURES } from './constants.js'
import type {
  ColumnMapping, CanonicalTransaction, PreConvertResult,
  BankDetectResult, FormatDetectResult, DuplicateGroup, AIFormatResult,
} from './types.js'

export interface PreConverterOptions {
  /** If provided, force a specific bank (skips detection) */
  forceBankCode?: string
  /** Format profiles keyed by (bank_code + format_signature) — loaded from DB before calling */
  formatProfiles?: Map<string, { id: string; column_mapping: ColumnMapping }>
}

export async function runPreConverter(
  rawBytes: Uint8Array,
  fileName: string,
  opts: PreConverterOptions = {},
): Promise<PreConvertResult> {

  // ── 1 & 2: File type detect + raw extract ─────────────────────────────────
  const isCSV = looksLikeCSV(rawBytes)
  let rows: string[][]

  if (isCSV) {
    const text = decodeText(rawBytes)
    rows = parseCSV(text)
  } else {
    rows = await parseXLSX(rawBytes.buffer as ArrayBuffer)
  }

  // Remove completely blank rows from the end
  while (rows.length && rows[rows.length - 1].every(c => c.trim() === '')) rows.pop()

  // ── 3 & 4: Header detect + Bank detect ────────────────────────────────────
  let bankResult: BankDetectResult

  if (opts.forceBankCode && BANK_SIGNATURES[opts.forceBankCode]) {
    const sig = BANK_SIGNATURES[opts.forceBankCode]
    bankResult = {
      bank_code: opts.forceBankCode,
      bank_name: sig.name,
      confidence: 100,
      method: 'heuristic',
      account_number: null,
      ifsc: null,
      branch: null,
    }
  } else {
    bankResult = detectBank(rows, fileName)
  }

  // ── 5: Column map — check format profile cache first ──────────────────────
  let mapping: ColumnMapping | null = null
  let profileId: string | null = null
  let formatSig = ''
  let formatMethod: FormatDetectResult['method'] = 'heuristic'

  // Find the header row and compute signature for cache lookup
  if (rows.length > 0) {
    const hdrIdx = findHeaderRow(rows)
    if (hdrIdx >= 0) {
      formatSig = computeFormatSignature(rows[hdrIdx])
      const cacheKey = `${bankResult.bank_code}:${formatSig}`
      const cached = opts.formatProfiles?.get(cacheKey)
      if (cached) {
        mapping = cached.column_mapping
        profileId = cached.id
        formatMethod = 'profile_cache'
      }
    }
  }

  if (!mapping && bankResult.confidence >= 70) {
    mapping = detectColumns(rows, bankResult.bank_code)
    if (mapping) formatMethod = 'heuristic'
  }

  // AI fallback when confidence < 70 or heuristic column detection failed
  if (!mapping || bankResult.confidence < 70) {
    const rawLines = rows.map(r => r.join(','))
    const aiResult = await aiDetectFormat(rawLines, isCSV ? 'csv' : 'xlsx')
    if (aiResult) {
      mapping = aiResultToMapping(aiResult, rows)
      bankResult = mergeAIBankInfo(bankResult, aiResult)
      formatMethod = 'ai'
      if (!formatSig) formatSig = computeFormatSignature(rows[aiResult.header_row] ?? [])
    }
  }

  if (!mapping) {
    throw new Error('Unable to detect column layout. Please ensure this is a valid bank statement.')
  }

  // ── 6: Data clean + extract canonical transactions ─────────────────────────
  const rawTransactions = extractTransactions(rows, mapping, bankResult.bank_code)

  if (!rawTransactions.length) {
    throw new Error('No transaction rows found after parsing. Check the file format.')
  }

  // ── 7: Sort order detect & fix ────────────────────────────────────────────
  const sortDetected = detectSortOrder(rawTransactions)
  const transactions = sortDetected === 'desc'
    ? [...rawTransactions].reverse().map((t, i) => ({ ...t, row_number: i + 1 }))
    : rawTransactions

  // ── 8: Balance derivation & validation ────────────────────────────────────
  const openingBalance = deriveOpeningBalance(transactions[0])
  const validation = validateBalanceContinuity(transactions, openingBalance)

  // ── 9: Duplicate detection ────────────────────────────────────────────────
  const duplicates = detectDuplicates(transactions)

  // ── Return (overlap check is done by the caller with DB access) ───────────
  const formatResult: FormatDetectResult = {
    mapping,
    profile_id:       profileId,
    confidence:       bankResult.confidence,
    method:           formatMethod,
    format_signature: formatSig,
  }

  // Sanitise account_number: Excel scientific notation and reject garbage values
  if (bankResult.account_number) {
    const sanitised = unscientificAccountNumber(bankResult.account_number)
    bankResult = { ...bankResult, account_number: sanitised || null }
  }

  return {
    bank:            bankResult,
    format:          formatResult,
    transactions,
    opening_balance: openingBalance,
    closing_balance: validation.closing_balance,
    period_from:     transactions[0].txn_date,
    period_to:       transactions[transactions.length - 1].txn_date,
    sort_detected:   sortDetected,
    validation,
    duplicates,
    overlap:         null,   // caller fills this in after DB check
    raw_rows:        rows,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractTransactions(
  rows: string[][],
  mapping: ColumnMapping,
  bankCode: string,
): CanonicalTransaction[] {
  const results: CanonicalTransaction[] = []
  let rowNum = 1

  for (let i = mapping.data_start_row; i < rows.length; i++) {
    const row = rows[i]

    // Skip completely empty rows
    if (row.every(c => c.trim() === '')) continue

    // Apply excel quoting strip to every cell if needed
    const cells = mapping.excel_quoted
      ? row.map(stripExcelQuoting)
      : row

    // Skip rows matching global or mapping-specific skip patterns.
    // GLOBAL_SKIP_PATTERNS are regex; mapping.skip_patterns are plain substrings.
    const joined = cells.join('')
    if (GLOBAL_SKIP_PATTERNS.some(p => p.test(joined.trim()))) continue
    if (mapping.skip_patterns.some(p => joined.includes(p))) continue

    // Date — required
    const rawDate = cells[mapping.date_col]?.trim()
    const txnDate = normaliseDate(rawDate)
    if (!txnDate) continue  // skip rows where date can't be parsed (footers, summaries)

    // Value date — optional
    const rawValueDate = mapping.value_date_col !== null
      ? cells[mapping.value_date_col]?.trim()
      : null
    const valueDate = rawValueDate ? normaliseDate(rawValueDate) : null

    // Narration
    const narration = cells[mapping.narration_col]?.trim() ?? ''
    if (!narration) continue

    // Reference
    const reference = mapping.reference_col !== null
      ? cells[mapping.reference_col]?.trim() || null
      : null

    // Amounts
    let debit: number | null = null
    let credit: number | null = null

    if (mapping.amount_col !== null && mapping.dr_cr_col !== null) {
      // Single-amount + Dr/Cr indicator column
      const amt = parseAmount(cells[mapping.amount_col])
      const side = cells[mapping.dr_cr_col]?.trim().toUpperCase()
      if (amt !== null && amt !== 0) {
        if (side === 'D' || side === 'DR' || side === 'DEBIT') debit = amt
        else credit = amt
      } else {
        continue  // zero-amount row — skip
      }
    } else {
      const rawDebit  = mapping.debit_col  !== null ? cells[mapping.debit_col]?.trim()  : null
      const rawCredit = mapping.credit_col !== null ? cells[mapping.credit_col]?.trim() : null
      debit  = rawDebit  ? parseAmount(rawDebit)  : null
      credit = rawCredit ? parseAmount(rawCredit) : null

      // Banks sometimes emit 0.00 in the inactive column; treat as absent
      if (debit  === 0) debit  = null
      if (credit === 0) credit = null

      // Skip rows where neither side has a value
      if (debit === null && credit === null) continue
    }

    // Guard: if column mapping misidentified a column, both sides may be non-null.
    // Prefer whichever side is non-zero; if both non-zero the mapping is genuinely wrong.
    if (debit !== null && credit !== null) {
      if (debit  === 0) debit  = null
      else if (credit === 0) credit = null
      else continue  // ambiguous — skip to avoid violating exactly_one_side
    }

    // Balance — required
    const rawBalance = cells[mapping.balance_col]?.trim()
    const balance = parseAmount(rawBalance)
    if (balance === null) continue

    results.push({
      row_number:  rowNum++,
      txn_date:    txnDate,
      value_date:  valueDate,
      narration,
      reference,
      debit:  debit  !== null ? roundMoney(debit)  : null,
      credit: credit !== null ? roundMoney(credit) : null,
      balance: roundMoney(balance),
    })
  }

  return results
}

function detectDuplicates(transactions: CanonicalTransaction[]): DuplicateGroup[] {
  const seen = new Map<string, number[]>()
  for (const txn of transactions) {
    const key = `${txn.txn_date}|${txn.debit ?? ''}|${txn.credit ?? ''}|${txn.narration}|${txn.reference ?? ''}`
    const group = seen.get(key) ?? []
    group.push(txn.row_number)
    seen.set(key, group)
  }
  const duplicates: DuplicateGroup[] = []
  for (const [key, rows] of seen.entries()) {
    if (rows.length > 1) duplicates.push({ key, row_numbers: rows })
  }
  return duplicates
}

function aiResultToMapping(ai: AIFormatResult, rows: string[][]): ColumnMapping {
  const skip: string[] = Array.isArray(ai.skip_patterns) ? ai.skip_patterns : []
  let dataStart = ai.data_start_row
  // Ensure data_start_row is after header_row
  if (dataStart <= ai.header_row) dataStart = ai.header_row + 1

  return {
    date_col:        ai.columns.date,
    value_date_col:  ai.columns.value_date ?? null,
    narration_col:   ai.columns.narration,
    reference_col:   ai.columns.reference ?? null,
    debit_col:       ai.columns.debit ?? null,
    credit_col:      ai.columns.credit ?? null,
    balance_col:     ai.columns.balance,
    amount_col:      ai.columns.amount ?? null,
    dr_cr_col:       ai.columns.dr_cr_indicator ?? null,
    date_format:     ai.date_format,
    number_format:   ai.number_format,
    header_row:      ai.header_row,
    data_start_row:  dataStart,
    skip_patterns:   skip,
    excel_quoted:    ai.excel_quoted,
  }
}

function mergeAIBankInfo(existing: BankDetectResult, ai: AIFormatResult): BankDetectResult {
  return {
    bank_code:      ai.bank_code || existing.bank_code,
    bank_name:      ai.bank_name || existing.bank_name,
    confidence:     90,
    method:         'ai',
    account_number: ai.account_number ?? existing.account_number,
    ifsc:           ai.ifsc           ?? existing.ifsc,
    branch:         existing.branch,
  }
}

// Excel renders long account numbers in scientific notation (e.g. 1.01502E+13 → 10150200014513)
function unscientificAccountNumber(val: string): string {
  const sci = val.trim().match(/^(\d+\.?\d*)[eE]\+(\d+)$/i)
  if (!sci) return val
  return Number(val).toFixed(0)
}
