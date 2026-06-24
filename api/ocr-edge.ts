/**
 * Vercel Edge Function — Invoice OCR via AWS Textract AnalyzeExpense
 * POST /api/ocr-edge
 *
 * Edge runtime: 25 s duration (Hobby + Pro), Web Crypto SigV4, native fetch.
 * No @aws-sdk — pure Web APIs only.
 *
 * Body (JSON): { fileBase64: string, fileType: string }
 * Returns: OcrResult JSON
 */

export const config = { runtime: 'edge' }

// ── SigV4 (Web Crypto — works in Edge runtime) ────────────────────────────────

const enc = new TextEncoder()

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))
}

async function hmacHex(key: Uint8Array, msg: string): Promise<string> {
  const b = await hmac(key, msg)
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
}

async function textractPost(opts: {
  accessKeyId: string
  secretAccessKey: string
  region: string
  target: string
  payload: Uint8Array
}): Promise<Response> {
  const { accessKeyId, secretAccessKey, region, target, payload } = opts
  const host     = `textract.${region}.amazonaws.com`
  const now      = new Date()
  const amzDate  = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z'
  const dateStamp = amzDate.slice(0, 8)

  // Hash the payload bytes (not the string) for accuracy
  const payloadHashBuf = await crypto.subtle.digest('SHA-256', payload)
  const payloadHash = Array.from(new Uint8Array(payloadHashBuf)).map(b => b.toString(16).padStart(2, '0')).join('')

  const ch: [string, string][] = [
    ['content-type', 'application/x-amz-json-1.1'],
    ['host',         host],
    ['x-amz-date',  amzDate],
    ['x-amz-target', target],
  ].sort(([a], [b]) => a.localeCompare(b))

  const canonicalHeaders = ch.map(([k, v]) => `${k}:${v}\n`).join('')
  const signedHeaders    = ch.map(([k]) => k).join(';')

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
      'Authorization':  authorization,
      'Content-Type':   'application/x-amz-json-1.1',
      'X-Amz-Date':     amzDate,
      'X-Amz-Target':   target,
    },
    body: payload,
  })
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface OcrLineItem {
  description: string; qty: string; rate: string; amount: string; hsn: string
}

interface OcrResult {
  invoiceNo:        string; invoiceDate:     string
  supplierName:     string; supplierGstin:   string
  recipientName:    string; recipientGstin:  string
  taxableValue:     number; totalGst:        number; totalAmount: number
  cgst:             number; sgst:            number; igst:        number
  gstType:          'intra' | 'inter' | 'unknown'
  supplierState:    string; recipientState:  string
  lineItems:        OcrLineItem[]
  confidence:       number; fieldConfidences: Record<string, number>
}

// ── GST routing ───────────────────────────────────────────────────────────────

function routeGst(supplierGstin: string | undefined, recipientGstin: string | undefined, totalGst: number) {
  const ss = (supplierGstin  ?? '').substring(0, 2).trim()
  const rs = (recipientGstin ?? '').substring(0, 2).trim()
  if (!ss || !rs || !/^\d{2}$/.test(ss) || !/^\d{2}$/.test(rs)) {
    return { cgst: 0, sgst: 0, igst: totalGst, type: 'unknown' as const, supplierState: ss, recipientState: rs }
  }
  if (ss === rs) {
    const half = Math.round((totalGst / 2) * 100) / 100
    return { cgst: half, sgst: half, igst: 0, type: 'intra' as const, supplierState: ss, recipientState: rs }
  }
  return { cgst: 0, sgst: 0, igst: totalGst, type: 'inter' as const, supplierState: ss, recipientState: rs }
}

// ── Parse Textract response ───────────────────────────────────────────────────

function parseAmount(str: string | undefined): number {
  if (!str) return 0
  return parseFloat(str.replace(/[₹$£€,\s]/g, '')) || 0
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSummary(raw: Record<string, any>): OcrResult {
  const doc            = (raw?.ExpenseDocuments ?? [])[0]
  const summaryFields  = doc?.SummaryFields  ?? []
  const lineItemGroups = doc?.LineItemGroups  ?? []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fieldMap = new Map<string, { value: string; confidence: number }>()
  for (const f of summaryFields) {
    const key  = f?.Type?.Text ?? ''
    const val  = f?.ValueDetection?.Text ?? ''
    const conf = f?.ValueDetection?.Confidence ?? 0
    if (key && val) fieldMap.set(key, { value: val, confidence: conf })
  }

  const get = (key: string) => fieldMap.get(key)?.value ?? ''

  const supplierGstin  = get('VENDOR_VAT_NUMBER')
  const recipientGstin = get('RECEIVER_VAT_NUMBER')
  const totalGst       = parseAmount(get('TAX'))
  const gst            = routeGst(supplierGstin, recipientGstin, totalGst)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lineItems: OcrLineItem[] = lineItemGroups.flatMap((group: any) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (group?.LineItems ?? []).map((item: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ff = item?.LineItemExpenseFields ?? []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lf = (type: string) => ff.find((f: any) => f?.Type?.Text === type)?.ValueDetection?.Text ?? ''
      return { description: lf('ITEM'), qty: lf('QUANTITY'), rate: lf('UNIT_PRICE'), amount: lf('PRICE'), hsn: lf('PRODUCT_CODE') }
    })
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scores = summaryFields.map((f: any) => f?.ValueDetection?.Confidence ?? 0).filter((c: number) => c > 0)
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
    invoiceNo:      get('INVOICE_RECEIPT_ID'),
    invoiceDate:    get('INVOICE_RECEIPT_DATE'),
    supplierName:   get('VENDOR_NAME'),
    supplierGstin,
    recipientName:  get('RECEIVER_NAME'),
    recipientGstin,
    taxableValue:   parseAmount(get('SUBTOTAL')),
    totalGst,
    totalAmount:    parseAmount(get('TOTAL')),
    cgst: gst.cgst, sgst: gst.sgst, igst: gst.igst,
    gstType: gst.type, supplierState: gst.supplierState, recipientState: gst.recipientState,
    lineItems, confidence, fieldConfidences,
  }
}

// ── CORS headers ──────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders })
  if (req.method !== 'POST')   return jsonRes({ error: 'Method not allowed' }, 405)

  let body: { fileBase64?: string; fileType?: string }
  try { body = await req.json() } catch { return jsonRes({ error: 'Invalid JSON body' }, 400) }

  const { fileBase64 } = body
  if (!fileBase64) return jsonRes({ error: 'Missing fileBase64' }, 400)

  if (fileBase64.length > 6_900_000) return jsonRes({ error: 'File exceeds the 5 MB limit' }, 413)

  // process.env is available in Vercel Edge Functions
  const accessKeyId     = (process.env.AWS_ACCESS_KEY_ID     ?? '').trim()
  const secretAccessKey = (process.env.AWS_SECRET_ACCESS_KEY ?? '').trim()
  const region          = (process.env.AWS_REGION            ?? 'ap-south-1').trim()

  if (!accessKeyId || !secretAccessKey) {
    return jsonRes({ error: 'Server misconfigured: AWS credentials missing' }, 500)
  }

  const payload = enc.encode(JSON.stringify({ Document: { Bytes: fileBase64 } }))

  let textractRes: Response
  try {
    textractRes = await textractPost({
      accessKeyId, secretAccessKey, region,
      target: 'Textract_20180627.AnalyzeExpense',
      payload,
    })
  } catch (err) {
    return jsonRes({ error: `Failed to reach AWS Textract: ${err}` }, 502)
  }

  if (!textractRes.ok) {
    const errText = await textractRes.text().catch(() => '')
    return jsonRes({ error: `Textract error ${textractRes.status}: ${errText}` }, 502)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await textractRes.json() as Record<string, any>
  return jsonRes(parseSummary(raw))
}
