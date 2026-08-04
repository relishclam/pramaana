// ── AI-assisted format detection — fallback when heuristic confidence < 70% ───
// Server-side ONLY. Never import in client components.

import Anthropic from '@anthropic-ai/sdk'
import type { AIFormatResult } from './types.js'

function getClient(): Anthropic {
  const proc = (globalThis as Record<string, unknown>)['process'] as
    { env?: Record<string, string | undefined> } | undefined
  const key = proc?.env?.['ANTHROPIC_API_KEY'] ?? ''
  if (!key) throw new Error('ANTHROPIC_API_KEY not set')
  return new Anthropic({ apiKey: key })
}

export async function aiDetectFormat(
  rawLines: string[],
  fileType: string,
): Promise<AIFormatResult | null> {
  let client: Anthropic
  try { client = getClient() } catch { return null }

  const sample = rawLines.slice(0, 25).join('\n')

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1000,
      system:     'You are a bank statement format detector for Indian banks. Respond with ONLY a JSON object, no markdown, no explanation.',
      messages: [{
        role:    'user',
        content: `Analyse this ${fileType} bank statement sample and return the format as JSON.

SAMPLE:
${sample}

Return ONLY this JSON structure:
{
  "bank_code": "HDFC|CANARA|FEDERAL|SIB|ICICI|SBI|AXIS|KOTAK|BOB|PNB|IOB|AIRWALLEX|OTHER",
  "bank_name": "full bank name",
  "account_number": "if visible in metadata rows, else null",
  "ifsc": "if visible, else null",
  "header_row": 0,
  "data_start_row": 1,
  "columns": {
    "date": 0,
    "value_date": null,
    "narration": 1,
    "reference": null,
    "debit": 2,
    "credit": 3,
    "balance": 4,
    "amount": null,
    "dr_cr_indicator": null
  },
  "date_format": "DD/MM/YY|DD-MM-YYYY|DD/MM/YYYY|DD-Mon-YYYY",
  "sort_order": "asc|desc",
  "number_format": "indian|international",
  "excel_quoted": false,
  "skip_patterns": []
}`,
      }],
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const cleaned = text.replace(/```json\s*|```\s*/g, '').trim()
    return JSON.parse(cleaned) as AIFormatResult
  } catch {
    return null
  }
}
