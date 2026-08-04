// ── Balance derivation and continuity validation ──────────────────────────────

import { roundMoney } from './number-utils.js'
import type { CanonicalTransaction, ValidationResult } from './types.js'

/**
 * Derive opening balance from the first (chronological) transaction.
 * opening = first_txn.balance - first_txn.credit + first_txn.debit
 */
export function deriveOpeningBalance(firstTxn: CanonicalTransaction): number {
  const credit = firstTxn.credit ?? 0
  const debit  = firstTxn.debit  ?? 0
  return roundMoney(firstTxn.balance - credit + debit)
}

/**
 * Validate balance continuity across all transactions.
 * Uses epsilon comparison (< 0.01) for floating-point safety.
 * Balance discontinuities are reported but are NOT blocking — user can proceed.
 */
export function validateBalanceContinuity(
  transactions: CanonicalTransaction[],
  openingBalance: number,
): ValidationResult {
  if (!transactions.length) {
    return {
      is_valid: false,
      opening_balance: openingBalance,
      closing_balance: openingBalance,
      computed_closing: openingBalance,
      total_debits: 0,
      total_credits: 0,
      balance_continuous: true,
      discontinuities: [],
      errors: ['No transactions found'],
    }
  }

  const discontinuities: ValidationResult['discontinuities'] = []
  let running      = openingBalance
  let totalDebits  = 0
  let totalCredits = 0

  for (const txn of transactions) {
    const credit = txn.credit ?? 0
    const debit  = txn.debit  ?? 0
    totalDebits  += debit
    totalCredits += credit

    const expected = roundMoney(running + credit - debit)
    if (Math.abs(expected - txn.balance) >= 0.01) {
      discontinuities.push({
        row:      txn.row_number,
        expected,
        actual:   txn.balance,
      })
    }
    // Always advance using actual balance to prevent error accumulation
    running = txn.balance
  }

  const closingBalance  = transactions[transactions.length - 1].balance
  const computedClosing = roundMoney(openingBalance + totalCredits - totalDebits)

  return {
    is_valid:         discontinuities.length === 0 && Math.abs(computedClosing - closingBalance) < 0.01,
    opening_balance:  openingBalance,
    closing_balance:  closingBalance,
    computed_closing: computedClosing,
    total_debits:     roundMoney(totalDebits),
    total_credits:    roundMoney(totalCredits),
    balance_continuous: discontinuities.length === 0,
    discontinuities,
    errors: [],
  }
}

/**
 * Detect sort order of transactions by comparing first and last date.
 * Falls back to mid-row check for same-day-only statements.
 */
export function detectSortOrder(transactions: CanonicalTransaction[]): 'asc' | 'desc' {
  if (transactions.length < 2) return 'asc'

  // Dates are ISO YYYY-MM-DD strings — lexicographic comparison is correct for date ordering
  const first = transactions[0].txn_date
  const last  = transactions[transactions.length - 1].txn_date

  if (first < last) return 'asc'
  if (first > last) return 'desc'

  // All same date — check a middle row's date against first
  const mid = transactions[Math.floor(transactions.length / 2)].txn_date
  if (first > mid) return 'desc'

  return 'asc'
}
