/**
 * useOcr — calls the Supabase Edge Function `ocr` and returns loading/result state.
 *
 * Before calling, the frontend uploads the original file to the bill-attachments
 * bucket and passes the storagePath here.
 */

import { useState, useCallback } from 'react'
import { supabase }              from '@/lib/supabase'

// ── Types (keep in sync with supabase/functions/ocr/index.ts) ─────────────────

export interface OcrLineItem {
  description: string
  qty:         string
  unit:        string
  rate:        string
  amount:      string
  hsn:         string
}

export interface OcrResult {
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
  // DB-written fields returned by the edge function
  scanId?:  string
  scanRef?: string
}

// ── Request params ─────────────────────────────────────────────────────────────

export interface OcrRequest {
  file:         File
  invoiceType:  'purchase' | 'sale'
  companyId:    string
  companyCode:  string
  userId:       string
}

// ── State ──────────────────────────────────────────────────────────────────────

export interface OcrState {
  loading:     boolean
  result:      OcrResult | null
  error:       string | null
  storagePath: string | null
}

// ── File → base64 helper ───────────────────────────────────────────────────────

async function fileToBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ── PDF → JPEG helper (page 1 at 2× scale, mirrors useInvoiceScan) ────────────
//
// The OCR Edge Function only accepts images (OpenAI image_url). Render the first
// page to a JPEG canvas client-side before uploading so the edge function always
// receives an image — not a raw PDF binary.

async function pdfToJpegBase64(file: File): Promise<{ base64: string; mimeType: string }> {
  if (file.type !== 'application/pdf') {
    const base64 = await fileToBase64(file)
    return { base64, mimeType: file.type }
  }
  try {
    const pdfjsLib = await import('pdfjs-dist')
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString()
    const arrayBuffer = await file.arrayBuffer()
    const pdf         = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
    const page        = await pdf.getPage(1)
    const viewport    = page.getViewport({ scale: 2.0 })
    const canvas      = document.createElement('canvas')
    canvas.width      = viewport.width
    canvas.height     = viewport.height
    const ctx         = canvas.getContext('2d')!
    await page.render({ canvasContext: ctx, canvas, viewport }).promise
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
    return { base64: dataUrl.split(',')[1] ?? '', mimeType: 'image/jpeg' }
  } catch {
    // PDF.js unavailable — fall back to raw base64.
    // The edge function will return a 400 with a clear message.
    const base64 = await fileToBase64(file)
    return { base64, mimeType: 'application/pdf' }
  }
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useOcr() {
  const [state, setState] = useState<OcrState>({
    loading:     false,
    result:      null,
    error:       null,
    storagePath: null,
  })

  const runOcr = useCallback(async (req: OcrRequest): Promise<OcrResult | null> => {
    const { file, invoiceType, companyId, companyCode, userId } = req

    // ── Client-side validation ──────────────────────────────────────────────
    const MAX_BYTES = 5 * 1024 * 1024
    if (file.size > MAX_BYTES) {
      setState(s => ({ ...s, error: 'File exceeds 5 MB. Please compress or use a smaller file.' }))
      return null
    }
    const ALLOWED = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'])
    if (!ALLOWED.has(file.type)) {
      setState(s => ({ ...s, error: 'Only PDF, JPG, and PNG files are accepted.' }))
      return null
    }

    setState({ loading: true, result: null, error: null, storagePath: null })

    // ── 1. Upload original file to bill-attachments ─────────────────────────
    const fy       = getFY(new Date().toISOString())
    const filePath = `${companyCode}/${fy}/${invoiceType}/${Date.now()}-${file.name}`

    const { error: uploadErr } = await supabase.storage
      .from('bill-attachments')
      .upload(filePath, file, { upsert: false })

    if (uploadErr) {
      console.error('Storage upload error:', uploadErr)
      // Non-fatal — proceed without storage_path
    }

    // ── 2. Convert to base64 (PDFs rendered to JPEG first) ───────────────────
    let fileBase64: string
    let fileType:   string
    try {
      const converted = await pdfToJpegBase64(file)
      fileBase64      = converted.base64
      fileType        = converted.mimeType
    } catch (err) {
      setState(s => ({ ...s, loading: false, error: 'Failed to read file.' }))
      return null
    }

    // ── 3. Call edge function ───────────────────────────────────────────────
    const { data, error: fnErr } = await supabase.functions.invoke<OcrResult & { duplicate?: boolean; scanRef?: string }>('ocr', {
      body: {
        fileBase64,
        fileType,           // image/jpeg for PDFs (converted above), original type for images
        invoiceType,
        companyId,
        userId,
        storagePath: uploadErr ? null : filePath,
      },
    })

    if (fnErr) {
      // Parse the error body — supabase.functions.invoke puts it in fnErr.context
      // deno-lint-ignore no-explicit-any
      const errBody = (fnErr as any)?.context ?? {}
      if (errBody?.error === 'COMPANY_MISMATCH') {
        setState(s => ({ ...s, loading: false, error: `Wrong company: ${errBody.message}` }))
        return null
      }
      const msg = fnErr.message ?? 'OCR failed. Please try again.'
      setState(s => ({ ...s, loading: false, error: msg }))
      return null
    }

    if (!data) {
      setState(s => ({ ...s, loading: false, error: 'OCR returned no data.' }))
      return null
    }

    // ── 4. Handle duplicate invoice ─────────────────────────────────────────
    // The edge function returns HTTP 409 for duplicate scan_ref
    // supabase.functions.invoke wraps non-2xx as fnErr, so this path
    // handles any data-level duplicate flag if the edge fn returns 200 anyway
    if ((data as { duplicate?: boolean }).duplicate) {
      setState(s => ({
        ...s, loading: false,
        error: `Duplicate invoice — scan ref ${(data as { scanRef?: string }).scanRef ?? ''} already exists.`,
      }))
      return null
    }

    const result = data as OcrResult
    setState({ loading: false, result, error: null, storagePath: uploadErr ? null : filePath })
    return result

  }, [])

  const reset = useCallback(() => {
    setState({ loading: false, result: null, error: null, storagePath: null })
  }, [])

  return { ...state, runOcr, reset }
}

// ── FY helper (mirrors edge function) ─────────────────────────────────────────

function getFY(isoDate: string): string {
  const d     = new Date(isoDate)
  const month = d.getMonth() + 1
  const year  = d.getFullYear()
  const start = month >= 4 ? year : year - 1
  return `${String(start).slice(2)}${String(start + 1).slice(2)}`
}
