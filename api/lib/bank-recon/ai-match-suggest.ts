// ── AI match suggestions — Tier 3 for transactions heuristics can't match ────
// Server-side ONLY. Never import in client components.

import Anthropic from '@anthropic-ai/sdk'
import type { AIMatchSuggestion } from './types.js'

interface UnmatchedBankTxn {
  id: string
  txn_date: string
  debit: number | null
  credit: number | null
  narration: string
  reference: string | null
}

interface CandidateVoucher {
  voucher_id: string
  voucher_date: string
  amount: number
  party_name: string
  narration: string
}

function getClient(): Anthropic | null {
  const proc = (globalThis as Record<string, unknown>)['process'] as
    { env?: Record<string, string | undefined> } | undefined
  const key = proc?.env?.['ANTHROPIC_API_KEY'] ?? ''
  if (!key) return null
  return new Anthropic({ apiKey: key })
}

export async function aiSuggestMatches(
  unmatchedTxns: UnmatchedBankTxn[],
  candidateVouchers: Map<string, CandidateVoucher[]>,
): Promise<AIMatchSuggestion[]> {
  if (!unmatchedTxns.length) return []
  const client = getClient()
  if (!client) return []  // graceful degradation — skip Tier 3

  const prompt = unmatchedTxns.map(txn => {
    const candidates = candidateVouchers.get(txn.id) ?? []
    return `BANK TXN [${txn.id}]:
  Date: ${txn.txn_date} | ${txn.debit != null ? 'DEBIT' : 'CREDIT'}: ₹${txn.debit ?? txn.credit}
  Narration: ${txn.narration}
  Ref: ${txn.reference ?? 'none'}

  CANDIDATES:
  ${candidates.length === 0 ? '(none)' : candidates.map(v =>
    `  [${v.voucher_id}] ${v.voucher_date} | ₹${v.amount} | ${v.party_name} | ${v.narration}`
  ).join('\n')}`
  }).join('\n\n')

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2000,
      system:     'You match Indian bank transactions to accounting vouchers. Consider amount similarity, date proximity, counterparty name matching, UPI/NEFT reference matching. Return ONLY a JSON array.',
      messages: [{
        role:    'user',
        content: `Match each bank transaction to its best voucher candidate (or null if no good match).

${prompt}

Return JSON array:
[{ "bank_txn_id": "...", "voucher_id": "matched ID or null", "confidence": 50, "reason": "..." }]`,
      }],
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
    const result = JSON.parse(text.replace(/```json\s*|```\s*/g, '').trim()) as AIMatchSuggestion[]
    return Array.isArray(result) ? result : []
  } catch {
    return []
  }
}
