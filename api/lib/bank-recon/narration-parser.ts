// ── Heuristic narration parser — covers ~70% of Indian bank narrations ────────

import type { ParsedNarration } from './types.js'

type PatternDef = {
  type: ParsedNarration['txn_type']
  pattern: RegExp
  extract: (m: RegExpMatchArray) => Partial<ParsedNarration>
}

const PATTERNS: PatternDef[] = [
  // HDFC UPI: UPI-<counterparty>-<upi_id>-<ifsc>-<ref>-<purpose>
  // Counterparty may contain hyphens; backtracking resolves via the @-anchored UPI ID field
  {
    type: 'UPI',
    pattern: /^UPI[-/](.+?)[-/](\S+@\S+)[-/](\w+)[-/](\d+)[-/]?(.*)/i,
    extract: m => ({
      counterparty:         m[1].trim(),
      counterparty_account: m[2],
      parsed_reference:     m[4],
      parsed_purpose:       m[5] || null,
    }),
  },
  // Federal UPIOUT: UPIOUT/<ref>/<upi_id>/Fed/...
  {
    type: 'UPI',
    pattern: /^UPIOUT\/(\d+)\/(\S+@\S+)\//i,
    extract: m => ({
      counterparty_account: m[2],
      parsed_reference:     m[1],
    }),
  },
  // Federal UPIIN: UPIIN/<ref>/<upi_id>/...
  {
    type: 'UPI',
    pattern: /^UPIIN\/(\d+)\/(\S+@\S+)\//i,
    extract: m => ({
      counterparty_account: m[2],
      parsed_reference:     m[1],
    }),
  },
  // ICICI UPI: UPI/<ref>/<...>
  {
    type: 'UPI',
    pattern: /^UPI\/(\d+)\//i,
    extract: m => ({
      parsed_reference: m[1],
    }),
  },
  // Canara MOB-IMPS-CR: MOB-IMPS-CR/<name>/<bank>/<acc>/<purpose>/<account>/<date>
  {
    type: 'IMPS',
    pattern: /^MOB-IMPS-CR\/(.+?)\/(.+?)\/(\d+)\//i,
    extract: m => ({
      counterparty:    m[1].trim(),
      parsed_reference: m[3],
    }),
  },
  // Canara IB-IMPS-DR: IB-IMPS-DR//<bank>/**<ref>//<datetime>/<txn_id>
  {
    type: 'IMPS',
    pattern: /^IB-IMPS-DR\/\/(\w+)\/\*\*(\d+)\/\//i,
    extract: m => ({
      parsed_reference: m[2],
    }),
  },
  // Federal Bank: FN IMPS = outward (IFO), FT IMPS = inward (IFI); both are IMPS transfers
  {
    type: 'IMPS',
    pattern: /^F[TN]\s+IMPS\/IF[OI]\/(\d+)\/(\w+)\/(.*)/i,
    extract: m => ({
      parsed_reference:     m[1],
      counterparty_account: m[2],
      parsed_purpose:       m[3] || null,
    }),
  },
  // NEFT credit: NEFT CR-<code>-<name>-<ref>
  {
    type: 'NEFT',
    pattern: /^NEFT\s*CR[-/](\w+)[-/](.+?)[-/](\S+)$/i,
    extract: m => ({
      counterparty:     m[2].trim(),
      parsed_reference: m[3],
    }),
  },
  // NEFT debit
  {
    type: 'NEFT',
    pattern: /^NEFT\s*DR[-/]/i,
    extract: () => ({}),
  },
  // Canara RTGS: RTGS Cr-<ref>-<ifsc>-<name>--//<ref2>
  {
    type: 'RTGS',
    pattern: /^RTGS\s*Cr[-/](\S+)[-/](\w+)[-/](.+?)[-/][-/]/i,
    extract: m => ({
      parsed_reference: m[1],
      counterparty:     m[3].trim(),
    }),
  },
  // Generic RTGS
  {
    type: 'RTGS',
    pattern: /^RTGS\s*(CR|DR)[-/]/i,
    extract: () => ({}),
  },
  // ATM cash withdrawal
  {
    type: 'ATM',
    pattern: /^ATM[-\s]?(Cash|CASH|WDL|CASH\s*WDL)/i,
    extract: () => ({}),
  },
  // Federal Bank ATM: TO ATM/<ref>/<location>
  {
    type: 'ATM',
    pattern: /^TO\s+ATM\//i,
    extract: () => ({}),
  },
  // POS
  {
    type: 'POS',
    pattern: /^POS\s+\d{6}/i,
    extract: () => ({}),
  },
  // Federal charge: CHRG/<type>/<amount>/<date>
  {
    type: 'CHARGE',
    pattern: /^CHRG\//i,
    extract: () => ({ is_charge: true }),
  },
  // Generic bank charges, GST, SMS
  {
    type: 'CHARGE',
    pattern: /^(ATM\s*[\/]?\s*IMPS\s*Transaction\s*Charge|SMS\s*CHARGE|GST\s*ON|SERVICE\s*CHARGE|PROCESSING\s*FEE|ANNUAL\s*FEE)/i,
    extract: () => ({ is_charge: true }),
  },
  // Canara GST: GST<digits>-<digits>
  {
    type: 'CHARGE',
    pattern: /^GST\d{9,}/i,
    extract: () => ({ is_charge: true }),
  },
  // Interest
  {
    type: 'INTEREST',
    pattern: /^(CREDIT\s*INTEREST|INT\.\s*ON|INTEREST\s*PAID|INTEREST\s*CREDIT)/i,
    extract: () => ({}),
  },
  // Cheque
  {
    type: 'CHEQUE',
    pattern: /^(CLG\s*\/\s*CMS|CLEARING|OUTWARD\s*CLEARING|INWARD\s*CLEARING|CMS\s*COLLECTION)/i,
    extract: () => ({}),
  },
  // Salary credits (all banks)
  {
    type: 'SALARY',
    pattern: /^(SALARY|SAL\/|SALARY\s*CREDIT|SAL\s*CR)/i,
    extract: () => ({}),
  },
  // Sweep and FD operations
  {
    type: 'SWEEP',
    pattern: /^(AUTO\s*SWEEP|SWEEP\s*(IN|OUT)|REVERSE\s*SWEEP)/i,
    extract: () => ({}),
  },
  {
    type: 'FD',
    pattern: /^(FD\s*MATURITY|FIXED\s*DEPOSIT|FDR\s*)/i,
    extract: () => ({}),
  },
]

export function parseNarration(narration: string): ParsedNarration {
  const text = narration.trim()

  for (const def of PATTERNS) {
    const m = text.match(def.pattern)
    if (m) {
      const extra = def.extract(m)
      return {
        txn_type:            def.type,
        counterparty:        extra.counterparty        ?? null,
        counterparty_account: extra.counterparty_account ?? null,
        parsed_reference:    extra.parsed_reference    ?? null,
        parsed_purpose:      extra.parsed_purpose      ?? null,
        is_charge:            extra.is_charge           ?? false,
        is_reversal:          /\b(reversal|reversed|RETURN(?:ED)?)\b/i.test(text),
      }
    }
  }

  return {
    txn_type:             'OTHER',
    counterparty:         null,
    counterparty_account: null,
    parsed_reference:     null,
    parsed_purpose:       null,
    is_charge:            false,
    is_reversal:          /\b(reversal|reversed|RETURN(?:ED)?)\b/i.test(text),
  }
}
