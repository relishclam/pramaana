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
import { AwsClient } from 'npm:aws4fetch'

// ── Inline AWS SigV4 (Web Crypto — no external deps needed in Deno) ──────────
const enc = new TextEncoder()

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))
}

async function hmacHex(key: Uint8Array, msg: string): Promise<string> {
  const b = await hmac(key, msg)
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}

async function textractPost(opts: {
  accessKeyId: string; secretAccessKey: string; region: string
  target: string; payload: string
}): Promise<Response> {
  const { accessKeyId, secretAccessKey, region, target, payload } = opts
  const host      = `textract.${region}.amazonaws.com`
  const now       = new Date()
  const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z'
  const dateStamp = amzDate.slice(0, 8)

  const payloadHash = await sha256hex(payload)

  // Canonical headers — sorted by lowercase key
  const ch: [string, string][] = [
    ['content-type', 'application/x-amz-json-1.1'],
    ['host',         host],
    ['x-amz-date',  amzDate],
    ['x-amz-target', target],
  ].sort(([a], [b]) => a.localeCompare(b))

  const canonicalHeaders = ch.map(([k, v]) => `${k}:${v}\n`).join('')
  const signedHeaders    = ch.map(([k]) => k).join(';')

  // NOTE: canonicalHeaders already ends with \n — do NOT add another via join
  const canonicalReq = `POST\n/\n\n${canonicalHeaders}${signedHeaders}\n${payloadHash}`

  const credentialScope = `${dateStamp}/${region}/textract/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256hex(canonicalReq),
  ].join('\n')

  const kDate    = await hmac(enc.encode(`AWS4${secretAccessKey}`), dateStamp)
  const kRegion  = await hmac(kDate, region)
  const kService = await hmac(kRegion, 'textract')
  const kSigning = await hmac(kService, 'aws4_request')
  const signature = await hmacHex(kSigning, stringToSign)

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return fetch(`https://${host}/`, {
    method: 'POST',
    headers: {
      'Authorization': authorization,
      'Content-Type':  'application/x-amz-json-1.1',
      'X-Amz-Date':    amzDate,
      'X-Amz-Target':  target,
    },
    body: payload,
  })
}

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
function parseSummary(raw: Record<string, unknown>): OcrResult {
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
  const accessKeyId     = Deno.env.get('AWS_ACCESS_KEY_ID')      ?? ''
  const secretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')  ?? ''
  // AnalyzeExpense is available in us-east-1, us-east-2, us-west-2, eu-west-1, etc.
  // Use TEXTRACT_REGION secret to override; default to us-east-1.
  const textractRegion  = Deno.env.get('TEXTRACT_REGION') ?? 'us-east-1'

  if (!accessKeyId || !secretAccessKey) {
    return json({ error: 'Server misconfigured: AWS credentials missing' }, 500)
  }

  // ── Call Textract AnalyzeExpense (aws4fetch handles SigV4 signing) ──────────
  const awsClient = new AwsClient({ accessKeyId, secretAccessKey, region: textractRegion, service: 'textract' })

  // Use Uint8Array body to prevent any runtime Content-Type charset injection
  const textractPayload = new TextEncoder().encode(
    JSON.stringify({ Document: { Bytes: fileBase64 } })
  )

  let textractRes: Response
  try {
    textractRes = await awsClient.fetch(
      `https://textract.${textractRegion}.amazonaws.com/`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'Textract_20180627.AnalyzeExpense',
        },
        body: textractPayload,
      }
    )
  } catch (err) {
    console.error('Textract fetch error:', err)
    return json({ error: 'Failed to reach AWS Textract' }, 502)
  }

  if (!textractRes.ok) {
    const errText = await textractRes.text().catch(() => '')
    console.error(`Textract ${textractRes.status}:`, errText)

    // ── Diagnostic probe v2 ────────────────────────────────────────────────
    // Use Uint8Array body to avoid any Content-Type charset mangling.
    // Check x-amzn-requestid to confirm we are hitting real AWS (not a proxy).
    // Test DetectDocumentText (oldest op) — if that returns MissingAuthenticationToken
    // but AnalyzeExpense returns UnknownOperation, region doesn't support AnalyzeExpense.
    // If ALL ops return UnknownOperation, the endpoint itself is wrong.
    const probeBodyBytes = new TextEncoder().encode('{"Document":{"Bytes":"AA=="}}')

    const probeTargets: Array<{ label: string; url: string; target: string }> = [
      { label: 'us-e1.AnalyzeExpense',      url: `https://textract.us-east-1.amazonaws.com/`,  target: 'Textract_20180627.AnalyzeExpense'      },
      { label: 'us-e1.DetectDocumentText',   url: `https://textract.us-east-1.amazonaws.com/`,  target: 'Textract_20180627.DetectDocumentText'   },
      { label: 'us-e1.AnalyzeDocument',      url: `https://textract.us-east-1.amazonaws.com/`,  target: 'Textract_20180627.AnalyzeDocument'      },
      { label: 'ap-s1.AnalyzeExpense',       url: `https://textract.ap-south-1.amazonaws.com/`, target: 'Textract_20180627.AnalyzeExpense'      },
      { label: 'ap-s1.DetectDocumentText',   url: `https://textract.ap-south-1.amazonaws.com/`, target: 'Textract_20180627.DetectDocumentText'   },
    ]

    const probe: Record<string, string> = {}
    for (const { label, url, target } of probeTargets) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': target },
          body: probeBodyBytes,
        })
        const reqId = r.headers.get('x-amzn-requestid') ?? 'NO-REQ-ID'
        probe[label] = `${r.status}: ${await r.text()} [${reqId}]`
      } catch (e) {
        probe[label] = `fetch-error: ${e}`
      }
    }
    console.error('Target probe results:', JSON.stringify(probe))
    return json({ error: `Textract error ${textractRes.status}: ${errText}`, targetProbe: probe }, 502)
  }

  const raw = await textractRes.json() as Record<string, unknown>
  const result = parseSummary(raw)

  return json(result)
})
