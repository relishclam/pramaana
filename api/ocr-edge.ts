/**
 * Vercel Edge Function — Invoice OCR via Anthropic Claude (Vision)
 * POST /api/ocr-edge
 *
 * Edge runtime: 25 s duration (Hobby + Pro).
 * Uses Claude 3.5 Haiku vision — plain JSON API, no AWS SigV4 or X-Amz-Target.
 *
 * Required Vercel env var: ANTHROPIC_API_KEY  (from console.anthropic.com)
 * Body (JSON): { fileBase64: string, fileType: string }
 * Returns: OcrResult JSON
 */

export const config = { runtime: 'edge' }

// ── Extraction prompt ─────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are an expert Indian GST invoice parser. Analyse this invoice image carefully and extract data with high accuracy.
Return ONLY a single valid JSON object — no markdown fences, no explanation, no trailing text.

{
  "invoiceNo":       "invoice / bill / receipt number exactly as printed (string, empty if absent)",
  "invoiceDate":     "date exactly as printed on invoice, e.g. 31/05/2026 or 31-05-2026 (string, empty if not found)",
  "supplierName":    "seller / vendor / landlord company or person name (string)",
  "supplierGstin":   "seller GSTIN — must be exactly 15 characters, alphanumeric, copy character-by-character (string, empty if absent)",
  "recipientName":   "buyer / bill-to / tenant company or person name (string)",
  "recipientGstin":  "buyer GSTIN — must be exactly 15 characters, alphanumeric, copy character-by-character (string, empty if absent)",
  "taxableValue":    taxable amount before GST as a plain integer or decimal (CRITICAL: Indian numbers use commas as thousand separators — 2,10,000 means TWO LAKH TEN THOUSAND = 210000, NOT 2100000),
  "cgst":            CGST amount as a plain number (0 if absent),
  "sgst":            SGST amount as a plain number (0 if absent),
  "igst":            IGST amount as a plain number (0 if absent),
  "totalAmount":     grand total including all taxes as a plain number,
  "lineItems": [
    {
      "description": "item or service description",
      "qty":         "quantity as string",
      "rate":        "unit price as string",
      "amount":      "line total as string",
      "hsn":         "HSN / SAC code (string, empty if absent)"
    }
  ]
}

CRITICAL RULES:
1. Indian number system: 1,00,000 = 100000 (one lakh), 10,00,000 = 1000000 (ten lakh), 2,10,000 = 210000. Remove all commas to get the actual number.
2. GSTIN — read each of the 15 characters individually from the printed text. Do NOT reconstruct or guess any character. Structure: positions 1-2 = 2-digit state code (numbers), positions 3-7 = 5 letters (PAN), positions 8-11 = 4 digits (PAN), position 12 = 1 letter (PAN entity type), position 13 = 1 digit or letter (registration sequence), position 14 = ALWAYS the letter Z, position 15 = 1 alphanumeric checksum. If you cannot clearly read a character, use '?' rather than guessing.
3. invoiceDate: return in YYYY-MM-DD format. If printed as DD/MM/YYYY or DD-MM-YYYY, convert it. Always include the date if visible anywhere on the invoice.
4. All monetary output values must be plain numbers — no ₹ symbol, no commas, no formatting.
5. If a field is genuinely absent, use "" for strings and 0 for numbers.
6. Do NOT add extra fields. Return ONLY the JSON object.`

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

function routeGst(supplierGstin: string, recipientGstin: string, totalGst: number) {
  const ss = supplierGstin.substring(0, 2).trim()
  const rs = recipientGstin.substring(0, 2).trim()
  if (!ss || !rs || !/^\d{2}$/.test(ss) || !/^\d{2}$/.test(rs)) {
    return { cgst: 0, sgst: 0, igst: totalGst, type: 'unknown' as const, supplierState: ss, recipientState: rs }
  }
  if (ss === rs) {
    const half = Math.round((totalGst / 2) * 100) / 100
    return { cgst: half, sgst: half, igst: 0, type: 'intra' as const, supplierState: ss, recipientState: rs }
  }
  return { cgst: 0, sgst: 0, igst: totalGst, type: 'inter' as const, supplierState: ss, recipientState: rs }
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

  const { fileBase64, fileType } = body
  if (!fileBase64) return jsonRes({ error: 'Missing fileBase64' }, 400)
  if (fileBase64.length > 6_900_000) return jsonRes({ error: 'File exceeds the 5 MB limit' }, 413)

  const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim()
  if (!apiKey) return jsonRes({ error: 'Server misconfigured: ANTHROPIC_API_KEY missing' }, 500)

  const mimeType = (fileType && fileType.startsWith('image/')) ? fileType : 'image/jpeg'

  // ── Call GPT-4o Vision ───────────────────────────────────────────────────
  let openaiRes: Response
  try {
    openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:      'gpt-4o',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: EXTRACTION_PROMPT },
            {
              type:      'image_url',
              image_url: { url: `data:${mimeType};base64,${fileBase64}`, detail: 'high' },
            },
          ],
        }],
      }),
    })
  } catch (err) {
    return jsonRes({ error: `Failed to reach OpenAI: ${err}` }, 502)
  }

  if (!openaiRes.ok) {
    const errText = await openaiRes.text().catch(() => '')
    return jsonRes({ error: `OpenAI error ${openaiRes.status}: ${errText}` }, 502)
  }

  const openaiData = await openaiRes.json() as Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textContent: string = (openaiData as any)?.choices?.[0]?.message?.content ?? ''

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let extracted: Record<string, any>
  try {
    // Gemini may wrap JSON in markdown fences despite response_mime_type — strip them
    const clean = textContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    extracted = JSON.parse(clean)
  } catch {
    return jsonRes({ error: `Could not parse Gemini response: ${textContent.slice(0, 300)}` }, 502)
  }

  // ── Build OcrResult ──────────────────────────────────────────────────────
  const cgst         = Number(extracted.cgst ?? 0)
  const sgst         = Number(extracted.sgst ?? 0)
  const igst         = Number(extracted.igst ?? 0)
  const totalGst     = Math.round((cgst + sgst + igst) * 100) / 100
  const supplierGstin = String(extracted.supplierGstin ?? '')
  const recipientGstin = String(extracted.recipientGstin ?? '')
  const gst = routeGst(supplierGstin, recipientGstin, totalGst)

  // Honour what Gemini extracted from the invoice; fall back to GSTIN-based routing
  const resolvedCgst = cgst > 0 || sgst > 0 || igst > 0 ? cgst : gst.cgst
  const resolvedSgst = cgst > 0 || sgst > 0 || igst > 0 ? sgst : gst.sgst
  const resolvedIgst = cgst > 0 || sgst > 0 || igst > 0 ? igst : gst.igst
  const resolvedType: 'intra' | 'inter' | 'unknown' =
    resolvedIgst > 0 && resolvedCgst === 0 ? 'inter'
    : resolvedCgst > 0                      ? 'intra'
    : gst.type

  const result: OcrResult = {
    invoiceNo:      String(extracted.invoiceNo  ?? ''),
    invoiceDate:    String(extracted.invoiceDate ?? ''),
    supplierName:   String(extracted.supplierName  ?? ''),
    supplierGstin,
    recipientName:  String(extracted.recipientName ?? ''),
    recipientGstin,
    taxableValue:   Number(extracted.taxableValue ?? 0),
    totalGst,
    totalAmount:    Number(extracted.totalAmount ?? 0),
    cgst:           resolvedCgst,
    sgst:           resolvedSgst,
    igst:           resolvedIgst,
    gstType:        resolvedType,
    supplierState:  gst.supplierState,
    recipientState: gst.recipientState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lineItems: ((extracted.lineItems ?? []) as any[]).map(li => ({
      description: String(li.description ?? ''),
      qty:         String(li.qty   ?? ''),
      rate:        String(li.rate  ?? ''),
      amount:      String(li.amount ?? ''),
      hsn:         String(li.hsn   ?? ''),
    })),
    confidence:       85,   // Gemini doesn't surface per-field scores
    fieldConfidences: {},
  }

  return jsonRes(result)
}
