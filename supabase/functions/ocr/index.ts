/**
 * ocr — Supabase Edge Function (Deno)
 *
 * Invoice OCR via OpenAI GPT-4o Vision.
 * Runs with up to 150 s wall-clock time.
 *
 * POST body (JSON):
 *   {
 *     fileBase64:  string,            // base64, no data-URI prefix
 *     fileType:    string,            // image/jpeg | image/png | application/pdf
 *     invoiceType: 'purchase'|'sale', // for scan_ref + DB write
 *     companyId:   string,            // UUID — company to scope the scan
 *     userId?:     string,            // UUID — user performing the scan
 *     storagePath?: string            // path in bill-attachments bucket
 *   }
 *
 * Required Supabase secrets (Dashboard → Edge Functions → Secrets):
 *   OPENAI_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Invoked from the browser via:
 *   supabase.functions.invoke('ocr', { body: { ... } })
 */

import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

// ── Types (keep in sync with frontend src/modules/invoice-scan/hooks/useOcr.ts) ──

interface OcrLineItem {
  description: string
  qty:         string
  unit:        string
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

// ── scan_ref helpers ──────────────────────────────────────────────────────────

function getFY(dateStr: string): string {
  const d     = new Date(dateStr)
  const year  = isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear()
  const month = isNaN(d.getTime()) ? new Date().getMonth() + 1 : d.getMonth() + 1
  const fyStart = month >= 4 ? year : year - 1
  return `${String(fyStart).slice(2)}${String(fyStart + 1).slice(2)}`
}

function buildScanRef(
  companyCode: string,
  invoiceType: string,
  invoiceDate: string,
  invoiceNo:   string,
  partyName:   string,
): string {
  const fy   = getFY(invoiceDate)
  const type = invoiceType === 'purchase' ? 'PUR' : 'SAL'
  const date = (invoiceDate ?? '').replace(/-/g, '').slice(0, 8) || new Date().toISOString().slice(0,10).replace(/-/g,'')
  const invNo = (invoiceNo ?? '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 15)
  const party = (partyName ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)
  return `${companyCode}/${fy}/${type}/${date}-${invNo}-${party}`
}

// ── GPT-4o system prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an Indian GST invoice parser. Extract all fields from the invoice image and return ONLY a valid JSON object — no markdown, no explanation, no backticks.

Return this exact structure:
{
  "invoiceNo": "",
  "invoiceDate": "YYYY-MM-DD or empty string",
  "supplierName": "",
  "supplierGstin": "",
  "recipientName": "",
  "recipientGstin": "",
  "taxableValue": 0,
  "totalGst": 0,
  "totalAmount": 0,
  "cgst": 0,
  "sgst": 0,
  "igst": 0,
  "lineItems": [
    {
      "description": "",
      "hsn": "",
      "qty": "",
      "unit": "",
      "rate": "",
      "amount": ""
    }
  ],
  "confidence": 0.0
}

Rules:
- GSTIN format: 2-digit state code + 10-char PAN + 3 chars (e.g. 32AAUFR0742E1ZB)
- Dates must be YYYY-MM-DD
- All numeric values as numbers, not strings
- confidence: your overall extraction confidence from 0.0 to 1.0
- If a field is not found, use empty string or 0
- Extract ALL line items visible in the invoice
- unit: KG, NOS, MTR, LTR, BOX, PKT etc — extract exactly as printed`

// ── Parse raw GPT response ────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
function parseGptResponse(raw: Record<string, unknown>): OcrResult {
  // Strip any accidental markdown fences
  const rawGstin    = raw.supplierGstin  as string ?? ''
  const rcptGstin   = raw.recipientGstin as string ?? ''
  const rawTotalGst = Number(raw.totalGst  ?? 0)

  // Validate/derive GST split using routeGst as fallback
  const extractedCgst = Number(raw.cgst ?? 0)
  const extractedSgst = Number(raw.sgst ?? 0)
  const extractedIgst = Number(raw.igst ?? 0)

  const gst = routeGst(rawGstin, rcptGstin, rawTotalGst)

  // Prefer GPT-extracted values when they sum correctly; fall back to routeGst
  const gstSumOk = Math.abs((extractedCgst + extractedSgst + extractedIgst) - rawTotalGst) < 1
  const cgst     = gstSumOk ? extractedCgst : gst.cgst
  const sgst     = gstSumOk ? extractedSgst : gst.sgst
  const igst     = gstSumOk ? extractedIgst : gst.igst
  const gstType  = gstSumOk
    ? (extractedCgst > 0 ? 'intra' : extractedIgst > 0 ? 'inter' : 'unknown') as 'intra' | 'inter' | 'unknown'
    : gst.type

  // deno-lint-ignore no-explicit-any
  const lineItems: OcrLineItem[] = ((raw.lineItems as any[]) ?? []).map((item: any) => ({
    description: String(item.description ?? ''),
    qty:         String(item.qty         ?? ''),
    unit:        String(item.unit        ?? ''),
    rate:        String(item.rate        ?? ''),
    amount:      String(item.amount      ?? ''),
    hsn:         String(item.hsn         ?? ''),
  }))

  return {
    invoiceNo:        String(raw.invoiceNo        ?? ''),
    invoiceDate:      String(raw.invoiceDate       ?? ''),
    supplierName:     String(raw.supplierName      ?? ''),
    supplierGstin:    rawGstin,
    recipientName:    String(raw.recipientName     ?? ''),
    recipientGstin:   rcptGstin,
    taxableValue:     Number(raw.taxableValue      ?? 0),
    totalGst:         rawTotalGst,
    totalAmount:      Number(raw.totalAmount       ?? 0),
    cgst, sgst, igst, gstType,
    supplierState:    gst.supplierState,
    recipientState:   gst.recipientState,
    lineItems,
    confidence:       Number(raw.confidence        ?? 0),
    fieldConfidences: {},
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: {
    fileBase64?:   string
    fileType?:     string
    invoiceType?:  string
    companyId?:    string
    userId?:       string
    storagePath?:  string
  }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { fileBase64, fileType, invoiceType, companyId, userId, storagePath } = body

  if (!fileBase64)  return json({ error: 'Missing fileBase64' }, 400)
  if (!invoiceType) return json({ error: 'Missing invoiceType' }, 400)
  if (!companyId)   return json({ error: 'Missing companyId' }, 400)

  // Size check (base64 is ~4/3 of raw; 5 MB raw ≈ 6.8 MB base64)
  if (fileBase64.length > 6_900_000) {
    return json({ error: 'File exceeds the 5 MB limit' }, 413)
  }

  // ── OpenAI credentials ────────────────────────────────────────────────────
  const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''
  if (!openaiKey) return json({ error: 'Server misconfigured: OPENAI_API_KEY missing' }, 500)

  // ── Supabase service client ───────────────────────────────────────────────
  const supabaseUrl         = Deno.env.get('SUPABASE_URL')              ?? ''
  const supabaseServiceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !supabaseServiceKey) {
    return json({ error: 'Server misconfigured: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing' }, 500)
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
    db:   { schema: 'pramaana' },
  })

  // ── Resolve company code ──────────────────────────────────────────────────
  const { data: company, error: compErr } = await supabase
    .from('companies')
    .select('code')
    .eq('id', companyId)
    .single()

  if (compErr || !company) {
    console.error('Company lookup failed:', compErr)
    return json({ error: 'Company not found' }, 400)
  }
  const companyCode = (company.code as string) ?? 'UNK'

  // ── Determine media type for OpenAI ───────────────────────────────────────
  // GPT-4o accepts image/* and application/pdf natively
  const mediaType = (fileType ?? 'image/jpeg') as string
  const isPdf = mediaType === 'application/pdf'

  // For PDFs: use document source type; for images: use image_url
  // deno-lint-ignore no-explicit-any
  let contentItem: any
  if (isPdf) {
    contentItem = {
      type:   'document',
      source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 },
    }
  } else {
    contentItem = {
      type:      'image_url',
      image_url: { url: `data:${mediaType};base64,${fileBase64}`, detail: 'high' },
    }
  }

  // ── Call GPT-4o Vision ────────────────────────────────────────────────────
  let openaiRes: Response
  try {
    openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:      'gpt-4o',
        max_tokens: 2048,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role:    'user',
            content: [
              { type: 'text', text: 'Extract all invoice fields from this image.' },
              contentItem,
            ],
          },
        ],
      }),
    })
  } catch (err) {
    console.error('OpenAI fetch error:', err)
    return json({ error: 'Failed to reach OpenAI API' }, 502)
  }

  if (!openaiRes.ok) {
    const errText = await openaiRes.text().catch(() => '')
    console.error(`OpenAI ${openaiRes.status}:`, errText)
    return json({ error: `OpenAI error ${openaiRes.status}: ${errText}` }, 502)
  }

  const openaiBody = await openaiRes.json() as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const rawContent = openaiBody.choices?.[0]?.message?.content ?? ''

  // Strip markdown code fences if GPT wraps in ```json ... ```
  const cleaned = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

  let parsedRaw: Record<string, unknown>
  try {
    parsedRaw = JSON.parse(cleaned)
  } catch (e) {
    console.error('JSON parse failed:', e, '\nRaw content:', cleaned)
    return json({ error: 'GPT-4o returned non-JSON response', raw: cleaned }, 502)
  }

  const result = parseGptResponse(parsedRaw)

  // ── Build scan_ref ────────────────────────────────────────────────────────
  const scanRef = buildScanRef(
    companyCode,
    invoiceType,
    result.invoiceDate,
    result.invoiceNo,
    result.supplierName || result.recipientName,
  )

  // ── Write to DB ───────────────────────────────────────────────────────────
  try {
    const { data: scan, error: scanErr } = await supabase
      .from('invoice_scans')
      .insert({
        company_id:    companyId,
        scan_ref:      scanRef,
        type:          invoiceType,
        invoice_no:    result.invoiceNo   || null,
        invoice_date:  result.invoiceDate || null,
        party_name:    result.supplierName || result.recipientName || null,
        party_gstin:   result.supplierGstin  || null,
        our_gstin:     result.recipientGstin || null,
        taxable_value: result.taxableValue,
        total_gst:     result.totalGst,
        cgst:          result.cgst,
        sgst:          result.sgst,
        igst:          result.igst,
        total_amount:  result.totalAmount,
        gst_type:      result.gstType,
        raw_json:      result,
        confidence:    result.confidence,
        storage_path:  storagePath ?? null,
        scanned_by:    userId ?? null,
      })
      .select('id')
      .single()

    if (scanErr) {
      // Unique constraint on scan_ref → duplicate invoice
      if (scanErr.code === '23505') {
        return json({
          error:    'Duplicate invoice — this scan_ref already exists.',
          scanRef,
          duplicate: true,
        }, 409)
      }
      console.error('invoice_scans insert error:', scanErr)
      // Non-fatal: return OCR result even if DB write fails
    } else if (scan?.id && result.lineItems.length > 0) {
      const itemsPayload = result.lineItems.map((item, idx) => ({
        scan_id:     scan.id,
        company_id:  companyId,
        line_no:     idx + 1,
        description: item.description || null,
        hsn_sac:     item.hsn         || null,
        quantity:    parseFloat(item.qty)    || null,
        unit:        item.unit               || null,
        unit_price:  parseFloat(item.rate)   || null,
        amount:      parseFloat(item.amount) || null,
      }))

      const { error: itemsErr } = await supabase
        .from('invoice_scan_items')
        .insert(itemsPayload)

      if (itemsErr) {
        console.error('invoice_scan_items insert error:', itemsErr)
      }

      return json({ ...result, scanId: scan.id, scanRef })
    }
  } catch (dbErr) {
    console.error('DB write exception:', dbErr)
  }

  return json({ ...result, scanRef })
})
