// ── Heuristic column detection — maps raw headers to ColumnMapping ────────────

import { BANK_SIGNATURES, normaliseHeaderCell } from './constants'
import { findHeaderRow } from './bank-detect'
import type { ColumnMapping } from './types'

const COLUMN_ALIASES: Record<keyof Pick<ColumnMapping,
  'date_col' | 'value_date_col' | 'narration_col' | 'reference_col' |
  'debit_col' | 'credit_col' | 'balance_col'>, string[]> = {
  date_col:        ['date', 'txndate', 'transactiondate', 'trandate'],
  value_date_col:  ['valuedate', 'valuedt', 'valudt', 'clearingdate'],
  narration_col:   ['narration', 'description', 'particulars', 'transactionremarks', 'remarks'],
  reference_col:   ['chqrefno', 'reference', 'chequeno', 'chequenumber', 'refno', 'utr', 'chqno', 'chequedetails'],
  debit_col:       ['debit', 'withdrawalamt', 'withdrawal', 'dr', 'debitamount', 'withdrawalamountinr'],
  credit_col:      ['credit', 'depositamt', 'deposit', 'cr', 'creditamount', 'depositamountinr'],
  balance_col:     ['balance', 'closingbalance', 'runningbalance', 'balanceamount', 'balanceinr'],
}

/**
 * Detect column mapping from headers.
 * Skips empty-header columns so Federal Bank's phantom column doesn't shift indices.
 */
export function detectColumns(
  rows: string[][],
  bankCode: string,
): ColumnMapping | null {
  const headerIdx = findHeaderRow(rows)
  if (headerIdx === -1) return null

  const rawHeaders = rows[headerIdx]

  // Build index map: normalised-name → actual column index (preserving real index)
  const colIndexMap: Map<string, number> = new Map()
  for (let i = 0; i < rawHeaders.length; i++) {
    const norm = normaliseHeaderCell(rawHeaders[i])
    if (norm.length > 0) colIndexMap.set(norm, i)
  }

  const findCol = (aliases: string[]): number | null => {
    for (const alias of aliases) {
      for (const [key, idx] of colIndexMap.entries()) {
        if (key.includes(alias) || alias.includes(key)) return idx
      }
    }
    return null
  }

  const date_col     = findCol(COLUMN_ALIASES.date_col)
  const narration_col = findCol(COLUMN_ALIASES.narration_col)
  const balance_col  = findCol(COLUMN_ALIASES.balance_col)

  // These three are required
  if (date_col === null || narration_col === null || balance_col === null) return null

  const sig = BANK_SIGNATURES[bankCode]

  // Determine data start row: first row after header that isn't a separator
  let dataStart = headerIdx + 1
  while (dataStart < rows.length) {
    const cells = rows[dataStart].filter(c => c.trim().length > 0)
    if (cells.length > 0 && !/^\*+$|^-+$/.test(cells.join(''))) break
    dataStart++
  }

  return {
    date_col,
    value_date_col:  findCol(COLUMN_ALIASES.value_date_col),
    narration_col,
    reference_col:   findCol(COLUMN_ALIASES.reference_col),
    debit_col:       findCol(COLUMN_ALIASES.debit_col),
    credit_col:      findCol(COLUMN_ALIASES.credit_col),
    balance_col,
    amount_col:      null,
    dr_cr_col:       null,
    date_format:     sig?.date_formats[0] ?? 'DD/MM/YYYY',
    number_format:   sig?.number_format ?? 'international',
    header_row:      headerIdx,
    data_start_row:  dataStart,
    skip_patterns:   ['********', '--------'],
    excel_quoted:    sig?.excel_quoted ?? false,
  }
}

/**
 * Compute a deterministic signature of the header row for format profile caching.
 * Skips empty cells, lowercases, joins with '|'.
 */
export function computeFormatSignature(headerRow: string[]): string {
  const norm = headerRow
    .map(c => normaliseHeaderCell(c))
    .filter(c => c.length > 0)
    .join('|')
  // Simple djb2-style hash for determinism without crypto API
  let hash = 5381
  for (let i = 0; i < norm.length; i++) {
    hash = ((hash << 5) + hash) + norm.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(16)
}
