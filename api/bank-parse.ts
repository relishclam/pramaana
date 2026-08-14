/**
 * Vercel Serverless Function (Node.js) — bank statement parser.
 * POST /api/bank-parse
 *
 * Body: { statement_id }
 *
 * Flow:
 *   1. Load bank_statements + bank_format_config
 *   2. Fetch file from bank-statements bucket
 *   3. Detect encoding (BOM check: UTF-16 LE / UTF-8 BOM / plain)
 *   4. Parse CSV (papaparse), XLSX (stub → error for v1), or JSON (Airwallex)
 *   5. Apply column_map + date_format + skip_footer_rows
 *   6. Validation gate: opening_balance + Σcredits − Σdebits = closing_balance ±0.01
 *   7. Insert bank_statement_lines; update statement status → 'parsed'
 *
 * Note: NOT edge runtime — uses Node.js Buffer for binary file handling
 *       and larger bundle budget (papaparse ~100KB).
 */

import Papa from 'papaparse'
import { parse as parseDate, isValid } from 'date-fns'

// ── Helpers ──────────────────────────────────────────────────────────────────

const envVar = (name: string): string =>
  (process.env[name] as string) ?? ''

const supabaseUrl = () => envVar('VITE_SUPABASE_URL')
const serviceKey  = () => envVar('SUPABASE_SERVICE_ROLE_KEY')

const pramaanaHeaders = {
  apikey:        serviceKey(),
  Authorization: `Bearer ${serviceKey()}`,
  'Accept-Profile': 'pramaana',
}

async function supabaseGet(path: string) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    headers: pramaanaHeaders,
  })
  if (!res.ok) throw new Error(`Supabase GET ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function supabasePatch(path: string, body: unknown) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...pramaanaHeaders, 'Content-Profile': 'pramaana', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Supabase PATCH ${path}: ${res.status} ${await res.text()}`)
}

async function supabasePost(path: string, body: unknown) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      ...pramaanaHeaders,
      'Content-Profile': 'pramaana',
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Supabase POST ${path}: ${res.status} ${await res.text()}`)
}

// ── Date parsing ─────────────────────────────────────────────────────────────

// Ordered by likelihood — configured format is tried first in parseConfigDate
const FALLBACK_DATE_FORMATS = [
  'dd-MM-yyyy', 'dd/MM/yyyy', 'dd MM yyyy',
  'dd-MMM-yyyy', 'dd/MMM/yyyy', 'dd MMM yyyy',
  'dd MMM yyyy HH:mm:ss', 'dd MMM yyyy HH:mm',
  'dd-MMM-yyyy HH:mm:ss', 'dd/MMM/yyyy HH:mm:ss',
  'MMM dd, yyyy', 'MMM d, yyyy',
  'yyyy-MM-dd', 'yyyy-MM-dd HH:mm:ss',
  'MM/dd/yyyy', 'yyyyMMdd',
  'dd-MM-yy',   'dd/MM/yy',
  'd-M-yyyy',   'd/M/yyyy',
]

function toDateFns(fmt: string): string {
  return fmt.replace('DD', 'dd').replace('YYYY', 'yyyy').replace('YY', 'yy')
}

function tryParseDate(token: string, fmts: string[]): Date | null {
  for (const f of fmts) {
    const d = parseDate(token, f, new Date())
    if (isValid(d)) return d
  }
  return null
}

function parseConfigDate(raw: string, fmt: string): Date | null {
  if (fmt === 'ISO8601') {
    const d = new Date(raw)
    return isValid(d) ? d : null
  }
  const primary = toDateFns(fmt)
  const fmts = [primary, ...FALLBACK_DATE_FORMATS.filter(f => f !== primary)]

  // Try the full string first (handles "01 Apr 2024", "01-Apr-2024", "01 Apr 2024 07:05:00")
  const full = tryParseDate(raw.trim(), fmts)
  if (full) return full

  // Strip a trailing time component ("01 Apr 2024 07:05:00" → "01 Apr 2024")
  const withoutTime = raw.trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, '').trim()
  if (withoutTime && withoutTime !== raw.trim()) {
    const d2 = tryParseDate(withoutTime, fmts)
    if (d2) return d2
  }

  // Also try just the first space-separated token for "DD/MM/YYYY HH:mm" style
  const firstToken = raw.trim().split(/\s+/)[0]
  return firstToken !== raw.trim() ? tryParseDate(firstToken, fmts) : null
}

const toISO = (d: Date) => d.toISOString().slice(0, 10)

// ── Amount normalization ──────────────────────────────────────────────────────

/** Strip Excel ="..." wrapper that some banks add when exporting via Excel */
function stripExcelEq(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = String(raw).trim()
  if (s.startsWith('="') && s.endsWith('"')) return s.slice(2, -1)
  if (s.startsWith('=')) return s.slice(1)
  return s
}

/** Clean a raw amount string to a plain decimal string */
function cleanAmountStr(raw: string): string {
  let s = stripExcelEq(raw).trim()
  // Parenthetical negative: (1234.56) → strip parens, caller decides sign
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1)
  // Strip currency symbols, commas, whitespace, trailing Dr/Cr labels
  return s
    .replace(/[₹$£€,\s]/g, '')
    .replace(/\s*(Dr|CR|dr|cr)\.?$/i, '')
    .trim()
}

/** Debit/credit columns — always positive, 0 when blank */
function parseAmount(raw: string | null | undefined): number {
  if (!raw) return 0
  const s = stripExcelEq(String(raw)).trim()
  if (!s || s === '-') return 0
  const n = parseFloat(cleanAmountStr(s))
  return isNaN(n) ? 0 : Math.abs(n)
}

/**
 * Balance column — preserves sign.
 * - Explicit minus sign → negative
 * - "Dr"/"DR" suffix → negative (overdraft / debit balance)
 * - "(amount)" notation → negative
 * - "Cr"/"CR" suffix → positive (strip label only)
 */
function parseBalance(raw: string | null | undefined): number | null {
  if (!raw) return null
  const s = stripExcelEq(String(raw)).trim()
  if (!s || s === '-') return null

  let sign: 1 | -1 = 1
  let work = s

  if (work.startsWith('(') && work.endsWith(')')) {
    work = work.slice(1, -1)
    sign = -1
  } else if (/\s*dr\.?$/i.test(work)) {
    sign = -1
    work = work.replace(/\s*dr\.?$/i, '')
  } else {
    work = work.replace(/\s*cr\.?$/i, '')
  }

  const cleaned = work.replace(/[₹$£€,\s]/g, '').trim()
  if (!cleaned) return null
  const n = parseFloat(cleaned)
  if (isNaN(n)) return null
  // If the string already carried a minus sign, honour it; otherwise apply our sign
  return n < 0 ? n : n * sign
}

// ── Encoding detection ────────────────────────────────────────────────────────

function decodeBuffer(buf: Buffer, hint: string): string {
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le')   // UTF-16 LE BOM
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf-8')  // UTF-8 BOM
  return buf.toString((hint as BufferEncoding) || 'utf-8')
}

// ── Column-alias resolver ────────────────────────────────────────────────────
// Tries: (1) exact match, (2) case-insensitive match, (3) known aliases.
// Covers net-banking CSV exports AND Adobe-extracted PDF table variants.

const COL_ALIASES: Record<string, string[]> = {
  date:       ['txn date','transaction date','tran date','date','posting date','trans date','value date entry'],
  value_date: ['value date','val date','value dt'],
  narration:  ['description','narration','particulars','transaction details','remarks','details','transaction narration'],
  ref:        ['cheque no.','cheque no','chq no','chq/ref number','ref no./cheque no.',
               'ref no','reference','cheque details','cheque ref. no.','instrument no'],
  debit:      ['debit','withdrawal (dr.)','withdrawal dr.','withdrawal','dr amount',
               'withdrawal amt.','dr.','debit amount','amount(dr)','amount (dr)'],
  credit:     ['credit','deposit (cr.)','deposit cr.','deposit','cr amount',
               'deposit amt.','cr.','credit amount','amount(cr)','amount (cr)'],
  balance:    ['balance','balance (rs.)','balance amount','closing balance',
               'running balance','running balance (rs)','bal'],
}

function resolveColumns(
  configMap: Record<string, string>,
  actualHeaders: string[],
): Record<string, string> {
  const lcMap = new Map(actualHeaders.map(h => [h.toLowerCase().trim(), h]))
  const resolved: Record<string, string> = {}
  for (const [key, configured] of Object.entries(configMap)) {
    if (actualHeaders.includes(configured)) { resolved[key] = configured; continue }
    const lc = configured.toLowerCase().trim()
    if (lcMap.has(lc)) { resolved[key] = lcMap.get(lc)!; continue }
    const hit = (COL_ALIASES[key] ?? []).find(a => lcMap.has(a))
    resolved[key] = hit ? lcMap.get(hit)! : configured
  }
  return resolved
}

// Score how many key columns (date, debit, credit, balance) a candidate header
// row resolves. Used by findHeaderRow to auto-detect the real header row.
const KEY_COLS = ['date', 'debit', 'credit', 'balance']

function scoreHeaders(configMap: Record<string, string>, headers: string[]): number {
  if (headers.every(h => !h.trim())) return 0
  const col = resolveColumns(configMap, headers)
  const lcSet = new Set(headers.map(h => h.toLowerCase().trim()).filter(Boolean))
  return KEY_COLS.filter(k => col[k] && lcSet.has(col[k].toLowerCase().trim())).length
}

// Scan up to maxScan rows starting from configuredHeaderRow (1-indexed) to find
// the row with the highest column match score.  Stops early at score >= 3.
function findHeaderRow(
  rawRows: string[][],
  configMap: Record<string, string>,
  configuredHeaderRow: number,
  maxScan = 40,
): number {
  const start = Math.max(0, configuredHeaderRow - 1)
  const end   = Math.min(rawRows.length - 2, start + maxScan)
  let bestIdx   = start
  let bestScore = 0
  for (let i = start; i <= end; i++) {
    const score = scoreHeaders(configMap, (rawRows[i] ?? []).map(h => String(h).trim()))
    if (score > bestScore) {
      bestScore = score
      bestIdx   = i
      if (score >= 3) break
    }
  }
  return bestIdx  // 0-indexed
}

// ── CSV parser ────────────────────────────────────────────────────────────────

interface ParsedLine {
  txn_date:        string
  value_date:      string | null
  narration:       string | null
  ref_no:          string | null
  debit:           number
  credit:          number
  running_balance: number | null
}

interface CSVResult {
  lines:         ParsedLine[]
  actualHeaders: string[]
  dateSamples:   string[]   // first 5 raw date-column values for diagnostics
}

function parseCSV(
  content: string,
  columnMap: Record<string, string>,
  dateFormat: string,
  headerRow: number,   // 1-indexed hint; auto-detection scans forward from here
  skipFooterRows: number,
): CSVResult {
  // Parse as raw arrays so we control which row becomes the header.
  // header:true would force row 1 as headers — wrong when banks prepend
  // title / account-info rows before the real column header row.
  const result = Papa.parse<string[]>(content, {
    header:         false,
    skipEmptyLines: 'greedy' as const,
  })
  const rawRows = result.data

  // Auto-detect the actual header row (scans up to 40 rows from the configured hint)
  const headerIdx    = findHeaderRow(rawRows, columnMap, headerRow)
  const actualHeaders = (rawRows[headerIdx] ?? []).map(h => String(h).trim())

  // Data rows are everything after the header row
  let dataRows = rawRows.slice(headerIdx + 1)

  // Drop footer rows (totals, "End of Statement", blank trailing rows)
  if (skipFooterRows > 0) dataRows = dataRows.slice(0, dataRows.length - skipFooterRows)

  // Resolve configured column names to actual header labels (alias-aware)
  const col = resolveColumns(columnMap, actualHeaders)

  // Build row objects: header label → cell value
  const rows: Record<string, string>[] = dataRows.map(row =>
    Object.fromEntries(actualHeaders.map((h, i) => [h, String(row[i] ?? '').trim()]))
  )

  const lines: ParsedLine[] = []
  const dateSamples: string[] = []

  for (const row of rows) {
    const rawDate = stripExcelEq(row[col.date])
    if (!rawDate.trim()) continue

    if (dateSamples.length < 5) dateSamples.push(rawDate)

    const d = parseConfigDate(rawDate, dateFormat)
    if (!d) continue

    const rawVD = stripExcelEq(row[col.value_date] ?? '')
    const vd    = rawVD ? parseConfigDate(rawVD, dateFormat) : null

    lines.push({
      txn_date:        toISO(d),
      value_date:      vd ? toISO(vd) : null,
      narration:       stripExcelEq(row[col.narration] ?? '').trim() || null,
      ref_no:          stripExcelEq(row[col.ref] ?? '').trim() || null,
      debit:           parseAmount(row[col.debit]),
      credit:          parseAmount(row[col.credit]),
      running_balance: parseBalance(row[col.balance]),
    })
  }

  return { lines, actualHeaders, dateSamples }
}

// ── Airwallex JSON parser ─────────────────────────────────────────────────────

function parseAirwallex(
  json: unknown,
  columnMap: Record<string, string>,
): ParsedLine[] {
  const rows = Array.isArray(json) ? json : (json as { transactions?: unknown[] })?.transactions ?? []
  return (rows as Record<string, unknown>[]).map((row) => {
    const dateStr = row[columnMap.date] as string
    const d = new Date(dateStr)
    return {
      txn_date:        isValid(d) ? toISO(d) : '',
      value_date:      null,
      narration:       (row[columnMap.narration] as string | null) ?? null,
      ref_no:          (row[columnMap.ref] as string | null) ?? null,
      debit:           parseAmount(row[columnMap.debit] as string),
      credit:          parseAmount(row[columnMap.credit] as string),
      running_balance: parseAmount(row[columnMap.balance] as string) || null,
    }
  }).filter(l => l.txn_date)
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
) {
  if (req.method !== 'POST') {
    res.writeHead(405); res.end(JSON.stringify({ error: 'Method not allowed' })); return
  }

  const rawBody = await new Promise<string>((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => { data += chunk.toString() })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })

  let body: { statement_id?: string }
  try { body = JSON.parse(rawBody) } catch {
    res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return
  }

  const { statement_id } = body
  if (!statement_id) {
    res.writeHead(400); res.end(JSON.stringify({ error: 'statement_id required' })); return
  }

  try {
    // ── Load statement + format config ──────────────────────────────────────
    const stmts = await supabaseGet(
      `bank_statements?id=eq.${statement_id}&select=id,company_id,bank_format_id,raw_content,period_from,period_to,status`
    ) as {
      id: string; company_id: string; bank_format_id: string;
      raw_content: string | null; period_from: string; period_to: string; status: string;
    }[]
    if (!stmts.length) throw new Error('Statement not found')
    const stmt = stmts[0]
    if (stmt.status !== 'uploaded') throw new Error(`Expected status=uploaded, got ${stmt.status}`)

    const bfcs = await supabaseGet(
      `bank_format_config?id=eq.${stmt.bank_format_id}&select=id,file_type,encoding,header_row,column_map,date_format,skip_footer_rows`
    ) as {
      id: string; file_type: string; encoding: string; header_row: number;
      column_map: Record<string, string>; date_format: string; skip_footer_rows: number;
    }[]
    if (!bfcs.length) throw new Error('Bank format config not found')
    const fmt = bfcs[0]

    if (fmt.file_type === 'xlsx') {
      // XLSX not supported in v1 — return actionable error
      res.writeHead(501)
      res.end(JSON.stringify({
        error: 'XLSX parsing not yet supported. Export as CSV from your bank portal.',
        statement_id,
      }))
      return
    }

    // ── Decode file from raw_content ───────────────────────────────────────────
    if (!stmt.raw_content) throw new Error('No file content stored for this statement')
    const fileBuffer = Buffer.from(stmt.raw_content, 'base64')

    if (fileBuffer.length === 0) throw new Error('Uploaded file is empty (0 bytes). Re-export and try again.')

    // Detect Excel binary (BIFF8 Compound Document: starts D0 CF 11 E0)
    if (fileBuffer[0] === 0xD0 && fileBuffer[1] === 0xCF && fileBuffer[2] === 0x11 && fileBuffer[3] === 0xE0) {
      res.writeHead(501)
      res.end(JSON.stringify({
        error: 'File is Excel binary format (.xls). Export as CSV (UTF-8) from your bank portal instead.',
        statement_id,
      }))
      return
    }

    // Detect HTML-as-XLS (many banks export HTML tables with a .xls extension)
    const previewStr = fileBuffer.slice(0, 200).toString('utf-8').trimStart()
    if (previewStr.startsWith('<') || previewStr.toLowerCase().startsWith('<!doctype') || previewStr.toLowerCase().includes('<html')) {
      res.writeHead(501)
      res.end(JSON.stringify({
        error: 'File appears to be an HTML table saved as .xls. In your bank portal use "Download as CSV" (not "Open in Excel"), then upload the .csv file.',
        statement_id,
      }))
      return
    }

    // ── Parse ───────────────────────────────────────────────────────────────
    let lines: ParsedLine[]
    let csvHeaders: string[] = []

    if (fmt.file_type === 'json') {
      let json: unknown
      try { json = JSON.parse(fileBuffer.toString('utf-8')) } catch {
        throw new Error('File is not valid JSON')
      }
      lines = parseAirwallex(json, fmt.column_map)
    } else {
      // CSV
      const content = decodeBuffer(fileBuffer, fmt.encoding)
      const parsed = parseCSV(content, fmt.column_map, fmt.date_format, fmt.header_row, fmt.skip_footer_rows)
      lines = parsed.lines
      csvHeaders = parsed.actualHeaders
      if (!lines.length && parsed.dateSamples.length) {
        csvHeaders = [...parsed.actualHeaders, `DATE_SAMPLES:${parsed.dateSamples.join(',')}`]
      }
    }

    if (!lines.length) {
      const fileBytes = fileBuffer.length
      const headerHint = csvHeaders.length ? `Headers detected: [${csvHeaders.join(' | ')}]. ` : 'No column headers detected. '
      const sampleHint = csvHeaders.some(h => h.startsWith('DATE_SAMPLES:'))
        ? ''
        : `File size: ${fileBytes} bytes. First 120 chars: ${previewStr.slice(0, 120).replace(/\r?\n/g, '↵')}`
      throw new Error(`No data rows found after parsing. ${headerHint}${sampleHint}`)
    }

    // Sort chronologically — some banks export newest-first (e.g. Federal Bank).
    // Balance validation and line_no must reflect oldest→newest order.
    lines.sort((a, b) => a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : 0)

    // ── Validation gate ─────────────────────────────────────────────────────
    const totalCredits = lines.reduce((s, l) => s + l.credit, 0)
    const totalDebits  = lines.reduce((s, l) => s + l.debit,  0)
    const opening      = lines[0].running_balance != null
      ? lines[0].running_balance - lines[0].credit + lines[0].debit
      : null
    const closing      = lines[lines.length - 1].running_balance

    if (opening !== null && closing !== null) {
      const expected  = Math.round((opening + totalCredits - totalDebits) * 100)
      const actual    = Math.round(closing * 100)
      if (Math.abs(expected - actual) > 1) {
        await supabasePatch(
          `bank_statements?id=eq.${statement_id}`,
          { parse_error: `Balance check failed: expected closing ${expected / 100}, found ${actual / 100}` },
        )
        res.writeHead(422)
        res.end(JSON.stringify({
          error: `Balance check failed. Opening ${opening} + credits ${totalCredits} - debits ${totalDebits} ≠ closing ${closing}. Fix the file and re-upload.`,
          statement_id,
        }))
        return
      }
    }

    // ── Insert lines in batches of 500 ──────────────────────────────────────
    const dbLines = lines.map((l, i) => ({
      statement_id,
      company_id:      stmt.company_id,
      line_no:         i + 1,
      txn_date:        l.txn_date,
      value_date:      l.value_date ?? null,
      narration:       l.narration,
      ref_no:          l.ref_no,
      debit:           l.debit,
      credit:          l.credit,
      running_balance: l.running_balance,
      match_status:    'unmatched',
    }))

    for (let i = 0; i < dbLines.length; i += 500) {
      await supabasePost('bank_statement_lines', dbLines.slice(i, i + 500))
    }

    // ── Update statement ────────────────────────────────────────────────────
    await supabasePatch(`bank_statements?id=eq.${statement_id}`, {
      status:          'parsed',
      line_count:      lines.length,
      opening_balance: opening,
      closing_balance: closing,
      parse_error:     null,
    })

    res.writeHead(200)
    res.end(JSON.stringify({
      statement_id,
      lines_parsed:    lines.length,
      opening_balance: opening,
      closing_balance: closing,
    }))

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Parse failed'
    // Mark parse error on statement
    try {
      await supabasePatch(`bank_statements?id=eq.${statement_id}`, { parse_error: msg })
    } catch { /* ignore */ }
    res.writeHead(500)
    res.end(JSON.stringify({ error: msg, statement_id }))
  }
}
