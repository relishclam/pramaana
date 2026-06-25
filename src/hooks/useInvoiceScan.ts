/**
 * useInvoiceScan — manages the full Invoice OCR → Draft Voucher state machine.
 *
 * Steps:
 *   1  Upload      — user selects a file
 *   2  Processing  — OCR call in flight
 *   3  Review      — user reviews / edits extracted fields
 *   4  Done        — draft voucher created; links to VoucherEdit
 */

import { useState, useCallback } from 'react'
import { saveDraftVoucher, type VoucherPayload } from '@/lib/vouchers'
import { supabase } from '@/lib/supabase'
import type { OcrResult, OcrLineItem } from '../../api/ocr'

export type { OcrResult, OcrLineItem }

// ── Form state (editable in Step 3) ──────────────────────────────────────────

export interface ScanForm {
  invoiceNo:      string
  invoiceDate:    string
  supplierName:   string
  supplierGstin:  string
  recipientName:  string
  recipientGstin: string
  taxableValue:   string
  cgst:           string
  sgst:           string
  igst:           string
  totalGst:       string
  totalAmount:    string
  voucherType:    'purchase' | 'sales' | 'journal' | 'payment' | 'receipt'
  narration:      string
  itcEligible:    boolean
  entityId:       string | null
  hsn:            string
  gstType:        'intra' | 'inter' | 'unknown'
}

// ── Top-level hook state ──────────────────────────────────────────────────────

export interface ScanState {
  step:         1 | 2 | 3 | 4
  file:         File | null
  previewUrl:   string | null   // object URL for image preview; null for PDFs
  isProcessing: boolean
  ocrResult:    OcrResult | null
  form:         ScanForm
  error:        string | null
  isSubmitting: boolean
  draftId:      string | null
}

// ── GSTIN regex ───────────────────────────────────────────────────────────────

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}\d[Z][A-Z\d]$/i

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultForm(): ScanForm {
  return {
    invoiceNo:      '',
    invoiceDate:    '',
    supplierName:   '',
    supplierGstin:  '',
    recipientName:  '',
    recipientGstin: '',
    taxableValue:   '0',
    cgst:           '0',
    sgst:           '0',
    igst:           '0',
    totalGst:       '0',
    totalAmount:    '0',
    voucherType:    'purchase',
    narration:      '',
    itcEligible:    true,
    entityId:       null,
    hsn:            '',
    gstType:        'unknown',
  }
}

function initialState(): ScanState {
  return {
    step:         1,
    file:         null,
    previewUrl:   null,
    isProcessing: false,
    ocrResult:    null,
    form:         defaultForm(),
    error:        null,
    isSubmitting: false,
    draftId:      null,
  }
}

function normalizeDate(dateStr: string): string {
  if (!dateStr) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr
  // DD/MM/YYYY or DD-MM-YYYY
  const m = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return dateStr
}

function ocrToForm(ocr: OcrResult, companyGstin = '', companyName = ''): ScanForm {
  const hsn = ocr.lineItems[0]?.hsn ?? ''

  // Detect if WE are the supplier → Sale voucher
  const gstinMatch = companyGstin
    ? ocr.supplierGstin.toUpperCase().replace(/\s/g, '') === companyGstin.toUpperCase().replace(/\s/g, '')
    : false
  const nameMatch = companyName
    ? ocr.supplierName.toLowerCase().includes(companyName.toLowerCase().replace(/pvt.*$/i, '').trim().toLowerCase())
    : false
  const isOurSale = gstinMatch || nameMatch

  const partyName = isOurSale ? ocr.recipientName : ocr.supplierName
  const narration = [
    partyName,
    ocr.invoiceNo ? `Inv ${ocr.invoiceNo}` : '',
    hsn ? `HSN ${hsn}` : '',
  ].filter(Boolean).join(' · ')

  return {
    invoiceNo:      ocr.invoiceNo,
    invoiceDate:    normalizeDate(ocr.invoiceDate),
    supplierName:   ocr.supplierName,
    // If WE are the supplier, use the authoritative company GSTIN (OCR often misreads it)
    supplierGstin:  isOurSale && companyGstin ? companyGstin : ocr.supplierGstin,
    recipientName:  ocr.recipientName,
    recipientGstin: ocr.recipientGstin,
    taxableValue:   String(ocr.taxableValue),
    cgst:           String(ocr.cgst),
    sgst:           String(ocr.sgst),
    igst:           String(ocr.igst),
    totalGst:       String(ocr.totalGst),
    totalAmount:    String(ocr.totalAmount),
    voucherType:    isOurSale ? 'sales' : 'purchase',
    narration,
    itcEligible:    !isOurSale,
    entityId:       null,
    hsn,
    gstType:        ocr.gstType,
  }
}

function recalcGst(form: ScanForm): ScanForm {
  const cgst  = parseFloat(form.cgst)  || 0
  const sgst  = parseFloat(form.sgst)  || 0
  const igst  = parseFloat(form.igst)  || 0
  const totalGst    = Math.round((cgst + sgst + igst) * 100) / 100
  const taxable     = parseFloat(form.taxableValue) || 0
  const totalAmount = Math.round((taxable + totalGst) * 100) / 100
  return { ...form, totalGst: String(totalGst), totalAmount: String(totalAmount) }
}

function rerouteGst(form: ScanForm): ScanForm {
  const ss = form.supplierGstin.substring(0, 2)
  const rs = form.recipientGstin.substring(0, 2)
  if (!ss || !rs || !/^\d{2}$/.test(ss) || !/^\d{2}$/.test(rs)) return form

  const totalGst = parseFloat(form.totalGst) || 0
  if (ss === rs) {
    const half = Math.round((totalGst / 2) * 100) / 100
    return { ...form, cgst: String(half), sgst: String(half), igst: '0', gstType: 'intra' }
  }
  return { ...form, cgst: '0', sgst: '0', igst: String(totalGst), gstType: 'inter' }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useInvoiceScan({ companyGstin = '', companyName = '' }: { companyGstin?: string; companyName?: string } = {}) {
  const [state, setState] = useState<ScanState>(initialState)

  // ── Step 1: Select file ───────────────────────────────────────────────────
  const selectFile = useCallback((file: File) => {
    const MAX = 5 * 1024 * 1024
    if (file.size > MAX) {
      setState(s => ({ ...s, error: 'File exceeds 5 MB. Please compress or use a smaller file.' }))
      return
    }
    const allowed = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'])
    if (!allowed.has(file.type)) {
      setState(s => ({ ...s, error: 'Only PDF, JPG, and PNG files are accepted.' }))
      return
    }
    const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
    setState(s => {
      if (s.previewUrl) URL.revokeObjectURL(s.previewUrl) // clean up old blob URL
      return { ...s, file, previewUrl, error: null }
    })
  }, [])

  // ── PDF → JPEG conversion (page 1 only, via pdfjs-dist) ─────────────────
  // Sending a JPEG to Textract is 3–5× faster than a raw PDF.
  // Falls back to the original file if PDF.js fails or the file is not a PDF.
  const extractFirstPageAsJpeg = useCallback(async (
    file: File,
  ): Promise<{ base64: string; mimeType: string }> => {
    if (file.type !== 'application/pdf') {
      // Already an image — just read it directly
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload  = () => resolve((r.result as string).split(',')[1] ?? '')
        r.onerror = reject
        r.readAsDataURL(file)
      })
      return { base64, mimeType: file.type }
    }

    try {
      // Lazy-load pdfjs-dist (only when a PDF is selected — tree-shakes out otherwise)
      const pdfjsLib = await import('pdfjs-dist')
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString()

      const arrayBuffer = await file.arrayBuffer()
      const pdf         = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
      const page        = await pdf.getPage(1)
      const viewport    = page.getViewport({ scale: 2.0 })   // 2× scale → clearer text for OCR

      const canvas    = document.createElement('canvas')
      canvas.width    = viewport.width
      canvas.height   = viewport.height
      const ctx       = canvas.getContext('2d')!
      await page.render({ canvasContext: ctx, canvas, viewport }).promise

      const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
      return { base64: dataUrl.split(',')[1] ?? '', mimeType: 'image/jpeg' }

    } catch {
      // PDF.js failed — fall back to sending the raw PDF
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload  = () => resolve((r.result as string).split(',')[1] ?? '')
        r.onerror = reject
        r.readAsDataURL(file)
      })
      return { base64, mimeType: 'application/pdf' }
    }
  }, [])

  // ── Step 2: Run OCR ───────────────────────────────────────────────────────
  const startScan = useCallback(async (file: File) => {
    setState(s => ({ ...s, step: 2, isProcessing: true, error: null }))

    try {
      // For PDFs: render page 1 to JPEG first — 3–5× faster in Textract
      const { base64: fileBase64, mimeType: fileType } = await extractFirstPageAsJpeg(file)

      // Use Vercel Edge Function — 25 s duration on Hobby plan, Vercel's own V8 runtime
      const ocrRes = await fetch('/api/ocr-edge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileBase64, fileType }),
      })
      if (!ocrRes.ok) {
        const errBody = await ocrRes.json().catch(() => ({ error: `OCR failed (${ocrRes.status})` }))
        throw new Error((errBody as { error?: string }).error ?? `OCR failed (${ocrRes.status})`)
      }
      const ocr: OcrResult = await ocrRes.json()
      setState(s => ({ ...s, step: 3, isProcessing: false, ocrResult: ocr, form: ocrToForm(ocr, companyGstin, companyName) }))

    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : 'Unexpected error'
      let msg = raw
      if (raw.includes('fetch') || raw.includes('network') || raw.includes('NetworkError')) {
        msg = 'Could not reach OCR service. Check your connection and try again.'
      } else if (raw.includes('AWS') || raw.includes('Textract')) {
        msg = 'AWS could not read this document. Ensure the invoice is clear and not handwritten.'
      }
      setState(s => ({ ...s, step: 1, isProcessing: false, error: msg }))
    }
  }, [])

  // ── Step 3: Update form field ─────────────────────────────────────────────
  const updateField = useCallback(<K extends keyof ScanForm>(key: K, value: ScanForm[K]) => {
    setState(s => {
      let form = { ...s.form, [key]: value }

      if (key === 'cgst' || key === 'sgst' || key === 'igst' || key === 'taxableValue') {
        form = recalcGst(form)
      }
      if (key === 'totalGst') {
        const taxable     = parseFloat(form.taxableValue) || 0
        const gst         = parseFloat(String(value))    || 0
        form.totalAmount  = String(Math.round((taxable + gst) * 100) / 100)
      }
      if (key === 'supplierGstin' || key === 'recipientGstin') {
        form = rerouteGst(form)
      }
      return { ...s, form }
    })
  }, [])

  // ── Step 3 → 4: Create draft voucher ─────────────────────────────────────
  const submitVoucher = useCallback(async (
    companyId:     string,
    voucherTypeId: string,
    userId:        string,
    ocrConfidence: number | null,
  ) => {
    setState(s => ({ ...s, isSubmitting: true, error: null }))

    const form = state.form

    // Normalise date — OCR may return many formats; try to keep ISO if possible
    let voucherDate = form.invoiceDate
    if (voucherDate && !voucherDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const parsed = new Date(voucherDate)
      voucherDate = isNaN(parsed.getTime())
        ? new Date().toISOString().slice(0, 10)
        : parsed.toISOString().slice(0, 10)
    }
    if (!voucherDate) voucherDate = new Date().toISOString().slice(0, 10)

    const payload: VoucherPayload = {
      company_id:          companyId,
      voucher_type_id:     voucherTypeId,
      voucher_number:      `DRAFT-${Date.now()}`,
      voucher_date:        new Date().toISOString().slice(0, 10), // booking date = today; invoice date in ref_document_number
      narration:           form.narration || null,
      entity_id:           form.entityId,
      amount:              parseFloat(form.totalAmount) || 0,
      payment_mode:        null,
      bank_ledger_id:      null,
      cheque_number:       null,
      cheque_date:         null,
      utr_number:          null,
      cost_centre_id:      null,
      ref_document_number: form.invoiceNo ? `${form.invoiceNo} dt ${form.invoiceDate || ''}`.trim() : null,
      status:              'draft',
      created_by:          userId,
    }

    try {
      // Save draft with no entries (user completes ledger entries in VoucherEdit)
      const draftId = await saveDraftVoucher(payload, [])

      // Annotate with OCR metadata
      if (ocrConfidence != null) {
        await supabase
          .schema('pramaana')
          .from('vouchers')
          .update({ ocr_confidence: ocrConfidence, source: 'ocr' })
          .eq('id', draftId)
      }

      setState(s => ({ ...s, step: 4, isSubmitting: false, draftId }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create voucher draft'
      setState(s => ({ ...s, isSubmitting: false, error: msg }))
    }
  }, [state.form])

  // ── Reset to Step 1 ───────────────────────────────────────────────────────
  const reset = useCallback(() => {
    setState(s => {
      if (s.previewUrl) URL.revokeObjectURL(s.previewUrl)
      return initialState()
    })
  }, [])

  return { state, selectFile, startScan, updateField, submitVoucher, reset }
}
