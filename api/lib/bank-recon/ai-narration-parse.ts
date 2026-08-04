// ── AI narration enrichment — batches of 50 for the ~30% heuristic misses ────
// Server-side ONLY. Never import in client components.

import Anthropic from '@anthropic-ai/sdk'
import type { AIParsedNarration } from './types.js'

function getClient(): Anthropic | null {
  const proc = (globalThis as Record<string, unknown>)['process'] as
    { env?: Record<string, string | undefined> } | undefined
  const key = proc?.env?.['ANTHROPIC_API_KEY'] ?? ''
  if (!key) return null
  return new Anthropic({ apiKey: key })
}

export async function aiParseNarrations(
  narrations: { index: number; text: string }[],
): Promise<AIParsedNarration[]> {
  if (!narrations.length) return []
  const client = getClient()
  if (!client) return []  // graceful degradation — leave as 'OTHER'

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 4000,
      system:     'You parse Indian bank transaction narrations into structured data. Return ONLY a JSON array. No markdown, no explanation.',
      messages: [{
        role:    'user',
        content: `Parse each narration. Return a JSON array.

${narrations.map(n => `${n.index}: ${n.text}`).join('\n')}

Each object:
{
  "index": number,
  "txn_type": "UPI|NEFT|RTGS|IMPS|ATM|POS|CHEQUE|FD|SWEEP|CHARGE|INTEREST|GST|SALARY|OTHER",
  "counterparty": "extracted name or null",
  "counterparty_account": "UPI ID or account number or null",
  "parsed_reference": "UTR/ref number or null",
  "parsed_purpose": "purpose/note or null",
  "is_charge": true (if bank charge / SMS fee / GST on charge, else false),
  "is_reversal": true (if narration contains reversal/reversed/return, else false)
}`,
      }],
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
    const result = JSON.parse(text.replace(/```json\s*|```\s*/g, '').trim()) as AIParsedNarration[]
    return Array.isArray(result) ? result : []
  } catch {
    return []  // graceful degradation
  }
}
