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

function parseConfigDate(raw: string, fmt: string): Date | null {
  // fmt: 'DD/MM/YYYY' | 'DD/MM/YY' | 'ISO8601' | 'MM/DD/YYYY' etc.
  if (fmt === 'ISO8601') {
    const d = new Date(raw)
    return isValid(d) ? d : null
  }
  // Convert bank format string to date-fns format string
  const dfnsFmt = fmt
    .replace('DD', 'dd')
    .replace('MM', 'MM')
    .replace('YYYY', 'yyyy')
    .replace('YY', 'yy')
  const d = parseDate(raw.trim(), dfnsFmt, new Date())
  return isValid(d) ? d : null
}

const toISO = (d: Date) => d.toISOString().slice(0, 10)

// ── Amount normalization ──────────────────────────────────────────────────────

/** Strip Excel ="..." wrapper that Canara/other banks add when exporting via Excel */
function stripExcelEq(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = String(raw).trim()
  // Matches ="value" or ="value" (with or without trailing quote)
  if (s.startsWith('="') && s.endsWith('"')) return s.slice(2, -1)
  if (s.startsWith('=')) return s.slice(1)
  return s
}

function parseAmount(raw: string | null | undefined): number {
  if (!raw) return 0
  const cleaned = stripExcelEq(String(raw)).replace(/[₹,\s]/g, '').trim()
  if (!cleaned || cleaned === '-') return 0
  const n = parseFloat(cleaned)
  return isNaN(n) ? 0 : Math.abs(n)
}

// ── Encoding detection ────────────────────────────────────────────────────────

function decodeBuffer(buf: Buffer, hint: string): string {
  // UTF-16 LE BOM: FF FE
  if (buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.slice(2).toString('utf16le')
  }
  // UTF-8 BOM: EF BB BF
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf-8')
  }
  // Default to configured encoding
  return buf.toString(hint as BufferEncoding ?? 'utf-8')
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

function parseCSV(
  content: string,
  columnMap: Record<string, string>,
  dateFormat: string,
  headerRow: number,
  skipFooterRows: number,
): ParsedLine[] {
  const result = Papa.parse(content, {
    header:       true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  })

  let rows = result.data as Record<string, string>[]

  // Skip configured header rows beyond row 1 (already consumed by papaparse)
  if (headerRow > 1) rows = rows.slice(headerRow - 1)

  // Skip footer rows
  if (skipFooterRows > 0) rows = rows.slice(0, rows.length - skipFooterRows)

  const lines: ParsedLine[] = []

  for (const row of rows) {
    const dateStr = row[columnMap.date]
    if (!dateStr?.trim()) continue

    // Strip Excel ="..." wrapper, then take only the date portion (ignore time)
    const cleanDate = stripExcelEq(dateStr).split(' ')[0].trim()
    const d = parseConfigDate(cleanDate, dateFormat)
    if (!d) continue

    const valueDateStr = row[columnMap.value_date ?? '']
    const cleanVD = valueDateStr ? stripExcelEq(valueDateStr).split(' ')[0].trim() : ''
    const vd = cleanVD ? parseConfigDate(cleanVD, dateFormat) : null

    const rawNarration = stripExcelEq(row[columnMap.narration] ?? '')
    const rawRef       = stripExcelEq(row[columnMap.ref] ?? '')

    lines.push({
      txn_date:        toISO(d),
      value_date:      vd ? toISO(vd) : null,
      narration:       rawNarration.trim() || null,
      ref_no:          rawRef.trim() || null,
      debit:           parseAmount(row[columnMap.debit]),
      credit:          parseAmount(row[columnMap.credit]),
      running_balance: parseAmount(row[columnMap.balance]) || null,
    })
  }

  return lines
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
    const stmts: {
      id: string; company_id: string; bank_format_id: string;
      raw_content: string | null; period_from: string; period_to: string; status: string;
    }[] = await supabaseGet(
      `bank_statements?id=eq.${statement_id}&select=id,company_id,bank_format_id,raw_content,period_from,period_to,status`
    )
    if (!stmts.length) throw new Error('Statement not found')
    const stmt = stmts[0]
    if (stmt.status !== 'uploaded') throw new Error(`Expected status=uploaded, got ${stmt.status}`)

    const bfcs: {
      id: string; file_type: string; encoding: string; header_row: number;
      column_map: Record<string, string>; date_format: string; skip_footer_rows: number;
    }[] = await supabaseGet(
      `bank_format_config?id=eq.${stmt.bank_format_id}&select=id,file_type,encoding,header_row,column_map,date_format,skip_footer_rows`
    )
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

    // ── Parse ───────────────────────────────────────────────────────────────
    let lines: ParsedLine[]

    if (fmt.file_type === 'json') {
      let json: unknown
      try { json = JSON.parse(fileBuffer.toString('utf-8')) } catch {
        throw new Error('File is not valid JSON')
      }
      lines = parseAirwallex(json, fmt.column_map)
    } else {
      // CSV
      const content = decodeBuffer(fileBuffer, fmt.encoding)
      lines = parseCSV(content, fmt.column_map, fmt.date_format, fmt.header_row, fmt.skip_footer_rows)
    }

    if (!lines.length) throw new Error('No data rows found after parsing')

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
