/**
 * Vercel Node.js Serverless Function — Invoice OCR via AWS Textract
 * POST /api/ocr
 *
 * Body (JSON): { fileBase64: string, fileType: string }
 *   fileBase64 : Base64-encoded file bytes (no data-URI prefix)
 *   fileType   : MIME type — application/pdf | image/jpeg | image/png
 *
 * Returns JSON with extracted invoice fields + GST routing.
 * Runs on Node.js runtime (not Edge) so the AWS SDK is available.
 */

import {
  TextractClient,
  AnalyzeExpenseCommand,
  type AnalyzeExpenseCommandOutput,
  type ExpenseField,
} from '@aws-sdk/client-textract'

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
])

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OcrLineItem {
  description: string
  qty:         string
  rate:        string
  amount:      string
  hsn:         string
}

export interface OcrResult {
  invoiceNo:       string
  invoiceDate:     string
  supplierName:    string
  supplierGstin:   string
  recipientName:   string
  recipientGstin:  string
  taxableValue:    number
  totalGst:        number
  totalAmount:     number
  cgst:            number
  sgst:            number
  igst:            number
  gstType:         'intra' | 'inter' | 'unknown'
  supplierState:   string
  recipientState:  string
  lineItems:       OcrLineItem[]
  confidence:      number                     // average across all fields (0–100)
  fieldConfidences: Record<string, number>    // per-field confidence
}

// ── GST Routing (exported for reuse / testing) ────────────────────────────────

export function routeGst(
  supplierGstin:  string | undefined,
  recipientGstin: string | undefined,
  totalGst:       number,
): {
  cgst: number; sgst: number; igst: number
  type: 'intra' | 'inter' | 'unknown'
  supplierState: string; recipientState: string
} {
  const supplierState  = (supplierGstin  ?? '').substring(0, 2).trim()
  const recipientState = (recipientGstin ?? '').substring(0, 2).trim()

  if (!supplierState || !recipientState || !/^\d{2}$/.test(supplierState) || !/^\d{2}$/.test(recipientState)) {
    return { cgst: 0, sgst: 0, igst: totalGst, type: 'unknown', supplierState, recipientState }
  }

  if (supplierState === recipientState) {
    const half = Math.round((totalGst / 2) * 100) / 100
    return { cgst: half, sgst: half, igst: 0, type: 'intra', supplierState, recipientState }
  }

  return { cgst: 0, sgst: 0, igst: totalGst, type: 'inter', supplierState, recipientState }
}

// ── Textract response parser ───────────────────────────────────────────────────

function parseAmount(str: string | undefined): number {
  if (!str) return 0
  return parseFloat(str.replace(/[₹$£€,\s]/g, '')) || 0
}

function parseSummary(raw: AnalyzeExpenseCommandOutput): OcrResult {
  const doc = (raw.ExpenseDocuments ?? [])[0]

  const summaryFields  = (doc?.SummaryFields ?? []) as ExpenseField[]
  const lineItemGroups = doc?.LineItemGroups ?? []

  // Build a map: TypeText → { value, confidence }
  const fieldMap = new Map<string, { value: string; confidence: number }>()
  for (const f of summaryFields) {
    const key  = f.Type?.Text ?? ''
    const val  = f.ValueDetection?.Text ?? ''
    const conf = f.ValueDetection?.Confidence ?? 0
    if (key && val) fieldMap.set(key, { value: val, confidence: conf })
  }

  function get(key: string) { return fieldMap.get(key)?.value ?? '' }

  const invoiceNo      = get('INVOICE_RECEIPT_ID')
  const invoiceDate    = get('INVOICE_RECEIPT_DATE')
  const supplierName   = get('VENDOR_NAME')
  const recipientName  = get('RECEIVER_NAME')
  const taxableValue   = parseAmount(get('SUBTOTAL'))
  const totalGst       = parseAmount(get('TAX'))
  const totalAmount    = parseAmount(get('TOTAL'))
  const supplierGstin  = get('VENDOR_VAT_NUMBER')
  const recipientGstin = get('RECEIVER_VAT_NUMBER')

  const gst = routeGst(supplierGstin, recipientGstin, totalGst)

  // Line items
  const lineItems: OcrLineItem[] = lineItemGroups.flatMap(group =>
    (group.LineItems ?? []).map(item => {
      const ff = (item.LineItemExpenseFields ?? []) as ExpenseField[]
      function lf(type: string) {
        return ff.find(f => f.Type?.Text === type)?.ValueDetection?.Text ?? ''
      }
      return {
        description: lf('ITEM'),
        qty:         lf('QUANTITY'),
        rate:        lf('UNIT_PRICE'),
        amount:      lf('PRICE'),
        hsn:         lf('PRODUCT_CODE'),
      }
    })
  )

  // Confidence: average across all detected summary fields
  const scores = summaryFields
    .map(f => f.ValueDetection?.Confidence ?? 0)
    .filter(c => c > 0)
  const confidence = scores.length > 0
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
    : 0

  const fieldConfidences: Record<string, number> = {}
  for (const f of summaryFields) {
    if (f.Type?.Text && f.ValueDetection?.Confidence != null) {
      fieldConfidences[f.Type.Text] = Math.round(f.ValueDetection.Confidence * 100) / 100
    }
  }
  return {
    invoiceNo,
    invoiceDate,
    supplierName,
    supplierGstin,
    recipientName,
    recipientGstin,
    taxableValue,
    totalGst,
    totalAmount,
    cgst:          gst.cgst,
    sgst:          gst.sgst,
    igst:          gst.igst,
    gstType:       gst.type,
    supplierState: gst.supplierState,
    recipientState: gst.recipientState,
    lineItems,
    confidence,
    fieldConfidences,
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: { fileBase64?: string; fileType?: string }
  try {
    body = await req.json() as { fileBase64?: string; fileType?: string }
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { fileBase64, fileType } = body

  if (!fileBase64) {
    return json({ error: 'Missing fileBase64' }, 400)
  }
  if (fileType && !ALLOWED_TYPES.has(fileType)) {
    return json({ error: 'Unsupported file type. Use PDF, JPG, or PNG.' }, 400)
  }

  // ── Decode + size check ───────────────────────────────────────────────────
  let buffer: Buffer
  try {
    buffer = Buffer.from(fileBase64, 'base64')
  } catch {
    return json({ error: 'Invalid base64 content' }, 400)
  }

  if (buffer.length > MAX_BYTES) {
    return json({ error: 'File exceeds the 5 MB limit' }, 413)
  }
  if (buffer.length === 0) {
    return json({ error: 'Empty file received' }, 400)
  }

  // ── AWS Textract ──────────────────────────────────────────────────────────
  const region          = process.env.AWS_REGION          ?? 'ap-south-1'
  const accessKeyId     = process.env.AWS_ACCESS_KEY_ID   ?? ''
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? ''

  if (!accessKeyId || !secretAccessKey) {
    return json({ error: 'Server misconfigured: AWS credentials missing' }, 500)
  }

  const client = new TextractClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  })

  let raw: AnalyzeExpenseCommandOutput
  try {
    raw = await client.send(new AnalyzeExpenseCommand({
      Document: { Bytes: buffer },
    }))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Textract call failed'
    return json({ error: `AWS Textract error: ${msg}` }, 500)
  }

  // ── Parse + return ────────────────────────────────────────────────────────
  const result = parseSummary(raw)
  return json(result, 200)
}
