/**
 * CSV export utility for Pramaana vouchers.
 * Pure client-side — no API call. Triggers a file download in the browser.
 *
 * Two formats:
 *   'summary'   — one row per voucher (header-level data)
 *   'lineitems' — one row per line item (falls back to one summary row)
 *
 * Files open correctly in Excel on Windows (UTF-8 BOM prefix, CRLF line endings).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CsvLineItem {
  description: string
  hsn:         string
  qty:         string
  rate:        string
  amount:      string
}

export interface VoucherRecord {
  voucherNo:      string
  voucherDate:    string       // ISO date YYYY-MM-DD
  voucherType:    string       // e.g. "Purchase"
  nature:         string       // e.g. "purchase"
  referenceNo:    string | null
  supplierName:   string | null
  supplierGstin:  string | null
  supplierState:  string | null
  recipientName:  string | null
  recipientGstin: string | null
  recipientState: string | null
  gstType:        string | null   // 'intra' | 'inter' | 'unknown' | null
  hsnCode:        string | null
  narration:      string | null
  taxableValue:   number
  cgstAmount:     number
  sgstAmount:     number
  igstAmount:     number
  totalGst:       number
  invoiceTotal:   number
  itcEligible:    boolean
  ocrConfidence:  number | null
  status:         string
  createdAt:      string         // ISO timestamp
  lineItems:      CsvLineItem[]
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso + (iso.includes('T') ? '' : 'T00:00:00'))
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${dd}-${mm}-${yyyy}`
}

function fmtAmt(n: number): string {
  return n.toFixed(2)
}

function fmtGstType(type: string | null): string {
  if (type === 'intra') return 'Intra-state'
  if (type === 'inter') return 'Inter-state'
  return 'Unknown'
}

// ── CSV cell escaping ─────────────────────────────────────────────────────────

function cell(value: string | number | boolean | null | undefined): string {
  const str = value == null ? '' : String(value)
  // Wrap in quotes if contains comma, double-quote, or newline
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function buildCsv(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const lines = [
    headers.map(cell).join(','),
    ...rows.map(row => row.map(cell).join(',')),
  ]
  return '\uFEFF' + lines.join('\r\n')   // UTF-8 BOM + CRLF
}

// ── Format A — Summary rows ───────────────────────────────────────────────────

function buildSummaryRows(vouchers: VoucherRecord[]): {
  headers: string[]
  data: (string | number | boolean | null | undefined)[][]
} {
  const headers = [
    'Voucher No', 'Voucher Date', 'Voucher Type', 'Reference Invoice No',
    'Supplier Name', 'Supplier GSTIN', 'Supplier State',
    'Recipient Name', 'Recipient GSTIN', 'Recipient State',
    'Supply Type', 'HSN Code', 'Narration',
    'Taxable Value', 'CGST Amount', 'SGST/TNGST Amount', 'IGST Amount',
    'Total GST', 'Invoice Total', 'ITC Eligible', 'OCR Confidence %',
    'Status', 'Created At',
  ]

  const data = vouchers.map(v => [
    v.voucherNo,
    fmtDate(v.voucherDate),
    v.voucherType,
    v.referenceNo ?? '',
    v.supplierName ?? '',
    v.supplierGstin ?? '',
    v.supplierState ?? '',
    v.recipientName ?? '',
    v.recipientGstin ?? '',
    v.recipientState ?? '',
    fmtGstType(v.gstType),
    v.hsnCode ?? '',
    v.narration ?? '',
    fmtAmt(v.taxableValue),
    fmtAmt(v.cgstAmount),
    fmtAmt(v.sgstAmount),
    fmtAmt(v.igstAmount),
    fmtAmt(v.totalGst),
    fmtAmt(v.invoiceTotal),
    v.itcEligible ? 'Yes' : 'No',
    v.ocrConfidence != null ? String(v.ocrConfidence) : '',
    v.status,
    fmtDate(v.createdAt),
  ])

  return { headers, data }
}

// ── Format B — Line item rows ─────────────────────────────────────────────────

function buildLineItemRows(vouchers: VoucherRecord[]): {
  headers: string[]
  data: (string | number | boolean | null | undefined)[][]
} {
  const headers = [
    'Voucher No', 'Invoice No', 'Supplier Name', 'Supplier GSTIN',
    'Line Item Description', 'HSN Code', 'Qty', 'Unit Rate', 'Line Amount',
    'CGST %', 'CGST Amt', 'SGST %', 'SGST Amt', 'IGST %', 'IGST Amt', 'Line Total',
  ]

  const data: (string | number | boolean | null | undefined)[][] = []

  for (const v of vouchers) {
    const items = v.lineItems.length > 0
      ? v.lineItems
      : [{ description: v.narration ?? '', hsn: v.hsnCode ?? '', qty: '', rate: '', amount: fmtAmt(v.invoiceTotal) }]

    // Distribute GST proportionally across line items
    const lineCount = items.length
    const cgstPer   = lineCount > 0 ? v.cgstAmount / lineCount : 0
    const sgstPer   = lineCount > 0 ? v.sgstAmount / lineCount : 0
    const igstPer   = lineCount > 0 ? v.igstAmount / lineCount : 0

    for (const li of items) {
      const lineAmt   = parseFloat(String(li.amount).replace(/[,\s]/g, '')) || 0
      const totalLine = lineAmt + cgstPer + sgstPer + igstPer
      data.push([
        v.voucherNo,
        v.referenceNo ?? '',
        v.supplierName ?? '',
        v.supplierGstin ?? '',
        li.description,
        li.hsn,
        li.qty,
        li.rate,
        fmtAmt(lineAmt),
        v.cgstAmount > 0 ? '' : '',   // % not known from OCR — left blank
        fmtAmt(cgstPer),
        v.sgstAmount > 0 ? '' : '',
        fmtAmt(sgstPer),
        v.igstAmount > 0 ? '' : '',
        fmtAmt(igstPer),
        fmtAmt(totalLine),
      ])
    }
  }

  return { headers, data }
}

// ── Filename builder ──────────────────────────────────────────────────────────

function buildFilename(voucherNo: string, format: 'summary' | 'lineitems', suffix?: string): string {
  const safe   = voucherNo.replace(/[\/\\:*?"<>|]/g, '-')
  const today  = fmtDate(new Date().toISOString()).replace(/-/g, '')
  const tag    = suffix ?? today
  return format === 'summary'
    ? `Pramaana_Voucher_${safe}_${tag}.csv`
    : `Pramaana_LineItems_${safe}_${tag}.csv`
}

function buildBulkFilename(format: 'summary' | 'lineitems', from: string, to: string): string {
  const ts   = Date.now()
  const fmtF = fmtDate(from).replace(/-/g, '')
  const fmtT = fmtDate(to).replace(/-/g, '')
  return format === 'summary'
    ? `Pramaana_Export_${fmtF}_to_${fmtT}_${ts}.csv`
    : `Pramaana_LineItems_${fmtF}_to_${fmtT}_${ts}.csv`
}

// ── Download trigger ──────────────────────────────────────────────────────────

function triggerDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href     = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Export a single voucher (or multiple) as CSV. */
export function exportVoucherCsv(
  vouchers:  VoucherRecord | VoucherRecord[],
  format:    'summary' | 'lineitems',
): void {
  const list = Array.isArray(vouchers) ? vouchers : [vouchers]
  if (list.length === 0) return

  const rows = format === 'summary'
    ? buildSummaryRows(list)
    : buildLineItemRows(list)

  const content  = buildCsv(rows.headers, rows.data)
  const filename = list.length === 1
    ? buildFilename(list[0].voucherNo, format)
    : buildBulkFilename(format, list[0].voucherDate, list[list.length - 1].voucherDate)

  triggerDownload(content, filename)
}

/** Convenience: bulk export with explicit date range label in filename. */
export function exportVouchersCsv(
  vouchers: VoucherRecord[],
  format:   'summary' | 'lineitems',
  from:     string,
  to:       string,
): void {
  if (vouchers.length === 0) return
  const rows     = format === 'summary' ? buildSummaryRows(vouchers) : buildLineItemRows(vouchers)
  const content  = buildCsv(rows.headers, rows.data)
  const filename = buildBulkFilename(format, from, to)
  triggerDownload(content, filename)
}
