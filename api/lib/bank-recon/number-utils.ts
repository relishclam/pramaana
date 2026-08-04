// ── Pure number utilities — Indian and international formats ──────────────────

/**
 * Strips Excel formula quoting: ="value" → value, ="123" → 123 (as string).
 * Canara Bank exports all cells in this format.
 */
export function stripExcelQuoting(value: unknown): string {
  if (typeof value !== 'string') return String(value ?? '')
  const m = value.match(/^="?(.*?)"?$/)
  return m ? m[1] : value
}

/**
 * Parses Indian or international formatted numbers.
 * Indian: 1,42,729.92  International: 142,729.92
 * Also handles: 853.00  ""  null  0  "₹1,00,000"
 */
export function parseAmount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return isNaN(value) ? null : value
  // Strip currency symbols, whitespace, commas — works for both number formats
  const cleaned = value.toString().replace(/[₹,\s]/g, '').trim()
  if (cleaned === '' || cleaned === '-') return null
  const num = parseFloat(cleaned)
  return isNaN(num) ? null : num
}

/**
 * Round a monetary value to 2 decimal places using integer arithmetic.
 * Never use floating-point round for money.
 */
export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Format a number as Indian rupee string (no currency symbol).
 */
export function formatIndian(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}
