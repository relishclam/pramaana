// ── Heuristic bank detection from raw rows ────────────────────────────────────

import { BANK_SIGNATURES, normaliseHeaderCell, GLOBAL_SKIP_PATTERNS } from './constants.js'
import type { BankDetectResult } from './types.js'

export function detectBank(rows: string[][], fileName: string): BankDetectResult {
  let bestCode   = ''
  let bestScore  = 0
  let bestMethod: 'heuristic' | 'ai' = 'heuristic'

  let accountNumber: string | null = null
  let ifsc: string | null = null

  // ── Pass 1: scan rows 0–20 for metadata patterns (bank name / IFSC) ────────
  const metaRows = rows.slice(0, 20).map(r => r.join(' '))
  for (const [code, sig] of Object.entries(BANK_SIGNATURES)) {
    for (const pat of sig.metadata_patterns) {
      const match = metaRows.find(r => pat.test(r))
      if (match) {
        if (95 > bestScore) { bestScore = 95; bestCode = code }
        // Try to extract account number from metadata rows
        if (!accountNumber) {
          // Account numbers sometimes come through as Excel scientific notation (1.01502E+13)
          const rawAcct = match.match(/(?:account\s*(?:no|number|#)\s*[:\-]?\s*)([\d.eE+]+)/i)
          if (rawAcct) accountNumber = unscientificAccountNumber(rawAcct[1])
          const ifscMatch = match.match(/(?:IFSC\s*[:\-]?\s*)([A-Z]{4}0[A-Z0-9]{6})/i)
          if (ifscMatch) ifsc = ifscMatch[1]
        }
      }
    }
  }

  // ── Pass 2: header row matching ───────────────────────────────────────────
  const headerRowIdx = findHeaderRow(rows)
  if (headerRowIdx !== -1) {
    const headerCells = rows[headerRowIdx]
      .map(c => c.trim())
      .filter(c => c.length > 0)  // skip empty-header columns (Federal Bank)

    for (const [code, sig] of Object.entries(BANK_SIGNATURES)) {
      for (const pattern of sig.header_patterns) {
        const score = fuzzyHeaderScore(headerCells, pattern)
        const confidence = Math.round(score * 100)
        if (confidence > bestScore) {
          bestScore = confidence
          bestCode  = code
        }
      }
    }
  }

  // ── Pass 3: narration markers scan (first 50 data rows) ──────────────────
  if (bestScore < 70) {
    const dataRows = rows.slice(headerRowIdx > 0 ? headerRowIdx + 1 : 0, headerRowIdx + 51)
    const narrations = dataRows.map(r => r.join(' '))

    for (const [code, sig] of Object.entries(BANK_SIGNATURES)) {
      if (!sig.narration_markers.length) continue
      const hits = sig.narration_markers.filter(marker =>
        narrations.some(n => n.includes(marker))
      ).length
      if (hits >= 3 && 80 > bestScore) {
        bestScore = 80
        bestCode  = code
      }
    }
  }

  // ── Pass 4: file name check ───────────────────────────────────────────────
  if (bestScore < 70) {
    const name = fileName.toLowerCase()
    for (const [code, sig] of Object.entries(BANK_SIGNATURES)) {
      if (name.includes(sig.name.toLowerCase().split(' ')[0].toLowerCase()) ||
          name.includes(code.toLowerCase())) {
        if (50 > bestScore) { bestScore = 50; bestCode = code }
      }
    }
  }

  if (!bestCode) {
    return { bank_code: '', bank_name: '', confidence: 0, method: 'heuristic', account_number: null, ifsc: null, branch: null }
  }

  const sig = BANK_SIGNATURES[bestCode]
  return {
    bank_code: bestCode,
    bank_name: sig?.name ?? bestCode,
    confidence: bestScore,
    method: bestMethod,
    account_number: accountNumber,
    ifsc,
    branch: null,
  }
}

/**
 * Find the index of the header row (0-based).
 * Skips decorative/metadata rows by looking for a row with multiple non-empty cells
 * that look like column headers (not numeric, not all-uppercase sentence-like text).
 */
export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = rows[i]
    const nonEmpty = row.filter(c => c.trim().length > 0)
    if (nonEmpty.length < 4) continue

    // Skip rows that are clearly skip patterns
    const joined = row.join('').trim()
    if (GLOBAL_SKIP_PATTERNS.some(p => p.test(joined))) continue

    // A header row typically has text cells, not all-numeric
    const numericCount = nonEmpty.filter(c => /^[\d,.\s₹%]+$/.test(c.trim())).length
    if (numericCount > nonEmpty.length * 0.5) continue

    // Check if any cell matches a known header keyword
    const normCells = nonEmpty.map(normaliseHeaderCell)
    const knownHeaders = ['date', 'narration', 'description', 'particulars', 'debit',
                          'credit', 'balance', 'withdrawal', 'deposit', 'amount', 'tran']
    const knownMatches = normCells.filter(c => knownHeaders.some(k => c.includes(k))).length
    if (knownMatches >= 2) return i
  }
  return -1
}

function fuzzyHeaderScore(actual: string[], expected: string[]): number {
  if (!expected.length) return 0
  const normActual   = actual.map(normaliseHeaderCell)
  const normExpected = expected.map(normaliseHeaderCell)
  let matched = 0
  for (const exp of normExpected) {
    if (normActual.some(act => act.includes(exp) || exp.includes(act))) matched++
  }
  return matched / normExpected.length
}

// Excel renders long numbers in scientific notation (e.g. 1.01502E+13 → 10150200014513)
// Treat any result under 6 chars or non-numeric as null (garbage from bad conversion).
function unscientificAccountNumber(val: string): string {
  const sci = val.trim().match(/^(\d+\.?\d*)[eE]\+(\d+)$/i)
  const converted = sci ? Number(val).toFixed(0) : val.trim()
  if (converted.length < 6 || !/^\d+$/.test(converted)) return ''
  return converted
}
