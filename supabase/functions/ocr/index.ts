/**
 * ocr — Supabase Edge Function (Deno)
 *
 * Invoice OCR via AWS Textract AnalyzeExpense (synchronous).
 * Runs with up to 150 s wall-clock time — no Vercel 10 s constraint.
 *
 * POST body (JSON): { fileBase64: string, fileType: string }
 *   fileBase64 : Base64-encoded file bytes (no data-URI prefix)
 *   fileType   : MIME type — image/jpeg | image/png | application/pdf
 *
 * Required Supabase secrets (Dashboard → Edge Functions → Secrets):
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   AWS_REGION              (default: ap-south-1)
 *
 * Invoked from the browser via:
 *   supabase.functions.invoke('ocr', { body: { fileBase64, fileType } })
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20'

// ── CORS ──────────────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Types (mirrors api/ocr.ts — keep in sync) ─────────────────────────────────

interface OcrLineItem {
  description: string
  qty:         string
  rate:        string
  amount:      string
  hsn:         string
}

interface OcrResult {
  invoiceNo:        string
  invoiceDate:      string
  supplierName:     string
  supplierGstin:    string
  recipientName:    string
  recipientGstin:   string
  taxableValue:     number
  totalGst:         number
  totalAmount:      number
  cgst:             number
  sgst:             number
  igst:             number
  gstType:          'intra' | 'inter' | 'unknown'
  supplierState:    string
  recipientState:   string
  lineItems:        OcrLineItem[]
  confidence:       number
  fieldConfidences: Record<string, number>
}

// ── GST Routing ───────────────────────────────────────────────────────────────

function routeGst(
  supplierGstin:  string | undefined,
  recipientGstin: string | undefined,
  totalGst:       number,
) {
  const supplierState  = (supplierGstin  ?? '').substring(0, 2).trim()
  const recipientState = (recipientGstin ?? '').substring(0, 2).trim()

  if (!supplierState || !recipientState ||
      !/^\d{2}$/.test(supplierState) || !/^\d{2}$/.test(recipientState)) {
    return { cgst: 0, sgst: 0, igst: totalGst, type: 'unknown' as const, supplierState, recipientState }
  }
  if (supplierState === recipientState) {
    const half = Math.round((totalGst / 2) * 100) / 100
    return { cgst: half, sgst: half, igst: 0, type: 'intra' as const, supplierState, recipientState }
  }
  return { cgst: 0, sgst: 0, igst: totalGst, type: 'inter' as const, supplierState, recipientState }
}

// ── Parse Textract response ───────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
function parseAmount(str: string | undefined): number {
  if (!str) return 0
  return parseFloat(str.replace(/[₹$£€,\s]/g, '')) || 0
}

// deno-lint-ignore no-explicit-any
function parseSummary(raw: any): OcrResult {
  const doc            = (raw?.ExpenseDocuments ?? [])[0]
  const summaryFields  = doc?.SummaryFields  ?? []
  const lineItemGroups = doc?.LineItemGroups  ?? []

  // deno-lint-ignore no-explicit-any
  const fieldMap = new Map<string, { value: string; confidence: number }>()
  for (const f of summaryFields) {
    const key  = f?.Type?.Text ?? ''
    const val  = f?.ValueDetection?.Text ?? ''
    const conf = f?.ValueDetection?.Confidence ?? 0
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

  // deno-lint-ignore no-explicit-any
  const lineItems: OcrLineItem[] = lineItemGroups.flatMap((group: any) =>
    // deno-lint-ignore no-explicit-any
    (group?.LineItems ?? []).map((item: any) => {
      // deno-lint-ignore no-explicit-any
      const ff = item?.LineItemExpenseFields ?? []
      function lf(type: string) {
        // deno-lint-ignore no-explicit-any
        return ff.find((f: any) => f?.Type?.Text === type)?.ValueDetection?.Text ?? ''
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

  const scores = summaryFields
    // deno-lint-ignore no-explicit-any
    .map((f: any) => f?.ValueDetection?.Confidence ?? 0)
    .filter((c: number) => c > 0)
  const confidence = scores.length > 0
    ? Math.round((scores.reduce((a: number, b: number) => a + b, 0) / scores.length) * 100) / 100
    : 0

  const fieldConfidences: Record<string, number> = {}
  for (const f of summaryFields) {
    if (f?.Type?.Text && f?.ValueDetection?.Confidence != null) {
      fieldConfidences[f.Type.Text] = Math.round(f.ValueDetection.Confidence * 100) / 100
    }
  }

  return {
    invoiceNo, invoiceDate, supplierName, supplierGstin,
    recipientName, recipientGstin, taxableValue, totalGst, totalAmount,
    cgst: gst.cgst, sgst: gst.sgst, igst: gst.igst,
    gstType: gst.type, supplierState: gst.supplierState,
    recipientState: gst.recipientState,
    lineItems, confidence, fieldConfidences,
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: { fileBase64?: string; fileType?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { fileBase64, fileType } = body
  if (!fileBase64) return json({ error: 'Missing fileBase64' }, 400)

  // Size check (base64 is ~4/3 of raw bytes; 5 MB raw ≈ 6.8 MB base64)
  if (fileBase64.length > 6_900_000) {
    return json({ error: 'File exceeds the 5 MB limit' }, 413)
  }

  // ── AWS credentials ───────────────────────────────────────────────────────
  const region          = Deno.env.get('AWS_REGION')             ?? 'ap-south-1'
  const accessKeyId     = Deno.env.get('AWS_ACCESS_KEY_ID')      ?? ''
  const secretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')  ?? ''

  if (!accessKeyId || !secretAccessKey) {
    return json({ error: 'Server misconfigured: AWS credentials missing' }, 500)
  }

  // ── Call Textract AnalyzeExpense ──────────────────────────────────────────
  const aws = new AwsClient({ accessKeyId, secretAccessKey, region, service: 'textract' })

  let textractRes: Response
  try {
    textractRes = await aws.fetch(`https://textract.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'Textract_20181101.AnalyzeExpense',
      },
      body: JSON.stringify({
        Document: { Bytes: fileBase64 },
      }),
    })
  } catch (err) {
    console.error('Textract fetch error:', err)
    return json({ error: 'Failed to reach AWS Textract' }, 502)
  }

  if (!textractRes.ok) {
    const errText = await textractRes.text().catch(() => '')
    console.error(`Textract error ${textractRes.status}:`, errText)
    return json({ error: `Textract returned ${textractRes.status}: ${errText}` }, 502)
  }

  const raw = await textractRes.json()
  const result = parseSummary(raw)

  return json(result)
})
