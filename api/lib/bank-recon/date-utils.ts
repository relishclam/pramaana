// ── Pure date utilities — all Indian bank formats ─────────────────────────────
// CRITICAL: Indian banks always use DD/MM — never interpret as MM/DD.

const MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function twoDigitYear(yy: number): number {
  return yy <= 49 ? 2000 + yy : 1900 + yy
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toISO(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`
}

/**
 * Normalise any Indian bank date string to YYYY-MM-DD.
 * Supported formats:
 *   DD/MM/YY            01/04/26
 *   DD/MM/YYYY          01/04/2026
 *   DD-MM-YYYY          01-04-2026
 *   DD-Mon-YYYY         01-Apr-2026
 *   DD Mon YYYY         01 Apr 2026
 *   DD-MM-YYYY HH:mm:ss  03-10-2024 17:36:32
 *   YYYY-MM-DD          2026-04-01  (already ISO)
 *
 * Returns null if the value cannot be parsed.
 */
export function normaliseDate(value: string | null | undefined): string | null {
  if (!value) return null
  const raw = value.toString().trim()
  if (!raw) return null

  // Already ISO: YYYY-MM-DD (optionally with time)
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`

  // DD-MM-YYYY HH:mm:ss  or  DD-MM-YYYY
  const dmy_dash = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/)
  if (dmy_dash) {
    const [, d, m, y] = dmy_dash
    return toISO(parseInt(y), parseInt(m), parseInt(d))
  }

  // DD/MM/YYYY
  const dmy_slash_4 = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (dmy_slash_4) {
    const [, d, m, y] = dmy_slash_4
    return toISO(parseInt(y), parseInt(m), parseInt(d))
  }

  // DD/MM/YY
  const dmy_slash_2 = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/)
  if (dmy_slash_2) {
    const [, d, m, yy] = dmy_slash_2
    return toISO(twoDigitYear(parseInt(yy)), parseInt(m), parseInt(d))
  }

  // DD-Mon-YYYY  or  DD Mon YYYY  (e.g. 01-Apr-2026  or  01 Apr 2026)
  const dmy_mon = raw.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[\s-](\d{4})/)
  if (dmy_mon) {
    const [, d, mon, y] = dmy_mon
    const m = MONTH_ABBR[mon.toLowerCase()]
    if (m) return toISO(parseInt(y), m, parseInt(d))
  }

  return null
}

/**
 * Compare two YYYY-MM-DD date strings.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
