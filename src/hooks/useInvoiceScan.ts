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

function ocrToForm(ocr: OcrResult): ScanForm {
  const hsn = ocr.lineItems[0]?.hsn ?? ''
  const narration = [
    ocr.supplierName,
    ocr.invoiceNo ? `Inv ${ocr.invoiceNo}` : '',
    hsn ? `HSN ${hsn}` : '',
  ].filter(Boolean).join(' · ')

  return {
    invoiceNo:      ocr.invoiceNo,
    invoiceDate:    ocr.invoiceDate,
    supplierName:   ocr.supplierName,
    supplierGstin:  ocr.supplierGstin,
    recipientName:  ocr.recipientName,
    recipientGstin: ocr.recipientGstin,
    taxableValue:   String(ocr.taxableValue),
    cgst:           String(ocr.cgst),
    sgst:           String(ocr.sgst),
    igst:           String(ocr.igst),
    totalGst:       String(ocr.totalGst),
    totalAmount:    String(ocr.totalAmount),
    voucherType:    'purchase',
    narration,
    itcEligible:    true,
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

export function useInvoiceScan() {
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

  // ── Step 2: Run OCR ───────────────────────────────────────────────────────
  const startScan = useCallback(async (file: File) => {
    setState(s => ({ ...s, step: 2, isProcessing: true, error: null }))

    try {
      // Read as base64 (strip the data-URI prefix)
      const fileBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload  = () => resolve((reader.result as string).split(',')[1] ?? '')
        reader.onerror = reject
        reader.readAsDataURL(file)
      })

      const res = await fetch('/api/ocr', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fileBase64, fileType: file.type }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string }
        throw new Error(err.error)
      }

      const ocr = (await res.json()) as OcrResult
      setState(s => ({ ...s, step: 3, isProcessing: false, ocrResult: ocr, form: ocrToForm(ocr) }))

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
      voucher_number:      'DRAFT',
      voucher_date:        voucherDate,
      narration:           form.narration || null,
      entity_id:           form.entityId,
      amount:              parseFloat(form.totalAmount) || 0,
      payment_mode:        null,
      bank_ledger_id:      null,
      cheque_number:       null,
      cheque_date:         null,
      utr_number:          null,
      cost_centre_id:      null,
      ref_document_number: form.invoiceNo || null,
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
