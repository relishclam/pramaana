import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  X, FileText, AlertTriangle, CheckCircle, Download, Loader2, ArrowLeft, Lock,
} from 'lucide-react'
import { toast } from 'sonner'
import { useInvoiceScan, GSTIN_RE, type ScanForm } from '@/hooks/useInvoiceScan'
import { exportVoucherCsv, type VoucherRecord } from '@/lib/exportVoucherCsv'
import { formatIndianCurrency } from '@/lib/vouchers'
import type { VoucherType } from '@/lib/vouchers'
import styles from './InvoiceScanModal.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  open:          boolean
  onClose:       () => void
  companyId:     string
  companyCode:   string
  companyGstin?: string
  companyName?:  string
  userId:        string
  voucherTypes:  VoucherType[]
}

// ── Stepper ───────────────────────────────────────────────────────────────────

const STEPS = ['Upload', 'Processing', 'Review', 'Done'] as const

function Stepper({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <div className={styles.stepper} role="list" aria-label="Steps">
      {STEPS.map((label, i) => {
        const num  = (i + 1) as 1 | 2 | 3 | 4
        const done = num < current
        const active = num === current
        return (
          <div key={label} className={styles.stepItem} role="listitem">
            <div className={[
              styles.stepDot,
              done || active ? (done ? styles.stepDotDone : styles.stepDotActive) : '',
            ].join(' ')}>
              {done ? <CheckCircle size={12} /> : num}
            </div>
            <span className={[
              styles.stepLabel,
              active ? styles.stepLabelActive : '',
            ].join(' ')}>
              {label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Field with label ──────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      {children}
    </div>
  )
}

// ── Confidence bar ────────────────────────────────────────────────────────────

function ConfBar({ value }: { value: number }) {
  const cls = value >= 90 ? styles.confBarGreen : value >= 70 ? styles.confBarAmber : styles.confBarRed
  return (
    <div className={styles.confBar}>
      <div className={`${styles.confBarFill} ${cls}`} style={{ width: `${value}%` }} />
    </div>
  )
}

// ── AmtInput — ₹ prefix + tabular-nums ───────────────────────────────────────

function AmtInput({
  id, label, value, onChange,
}: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <div className={styles.amtPrefix} style={{ position: 'relative' }}>
        <span className={styles.rupeeSign}>₹</span>
        <input
          id={id}
          className={styles.input}
          style={{ paddingLeft: '1.5rem', fontVariantNumeric: 'tabular-nums' }}
          value={value}
          onChange={e => onChange(e.target.value)}
          inputMode="decimal"
          aria-label={label}
        />
      </div>
    </Field>
  )
}

// ── Step 1: Upload ────────────────────────────────────────────────────────────

function StepUpload({
  file, previewUrl, error, onFile, onScan,
}: {
  file: File | null
  previewUrl: string | null
  error: string | null
  onFile: (f: File) => void
  onScan: () => void
}) {
  const inputRef   = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)

  function fmtSize(bytes: number) {
    if (bytes < 1024)       return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setDrag(false)
    const f = e.dataTransfer.files[0]
    if (f) onFile(f)
  }

  return (
    <>
      <div className={styles.body}>
        {error && (
          <div className={styles.errorBanner} role="alert">
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            {error}
          </div>
        )}

        {/* Drop zone */}
        <div
          className={`${styles.uploadZone} ${drag ? styles.uploadZoneActive : ''}`}
          onDragOver={e => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={handleDrop}
          onClick={() => !file && inputRef.current?.click()}
          role="button"
          tabIndex={0}
          aria-label="Drop invoice file here or click to browse"
          onKeyDown={e => e.key === 'Enter' && inputRef.current?.click()}
        >
          <FileText size={40} className={styles.uploadIcon} />
          <p className={styles.uploadText}>Drop invoice PDF or image here</p>
          <p className={styles.uploadSub}>PDF, JPG, PNG · Max 5 MB</p>
          <button
            type="button"
            className={styles.uploadBrowse}
            onClick={e => { e.stopPropagation(); inputRef.current?.click() }}
          >
            Or browse files
          </button>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }}
          aria-hidden="true"
        />

        {/* File preview row */}
        {file && (
          <div className={styles.filePreviewRow}>
            {previewUrl ? (
              <img src={previewUrl} alt="Invoice preview" className={styles.previewImg} />
            ) : (
              <div className={styles.pdfIcon}>
                <FileText size={22} />
                <span className={styles.pdfLabel}>PDF</span>
              </div>
            )}
            <div className={styles.fileInfo}>
              <div className={styles.fileName}>{file.name}</div>
              <div className={styles.fileSize}>{fmtSize(file.size)}</div>
            </div>
            <button
              type="button"
              className={styles.removeFile}
              onClick={() => onFile(null as unknown as File)}
              aria-label="Remove file"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      <div className={styles.step1Footer}>
        <button
          className={styles.btnPrimary}
          disabled={!file}
          onClick={onScan}
        >
          Scan Invoice
        </button>
      </div>
    </>
  )
}

// ── Step 2: Processing ────────────────────────────────────────────────────────

const STATUS_MSGS = [
  'Uploading to GPT-4o Vision…',
  'Reading invoice fields…',
  'Applying GST routing logic…',
]

function StepProcessing() {
  const [visible, setVisible] = useState(0)

  useEffect(() => {
    const timers = STATUS_MSGS.map((_, i) =>
      setTimeout(() => setVisible(i + 1), i * 900),
    )
    return () => timers.forEach(clearTimeout)
  }, [])

  return (
    <div className={styles.body}>
      <div className={styles.processingWrap}>
        <div className={styles.spinner} role="status" aria-label="Processing" />
        <div className={styles.statusLines}>
          {STATUS_MSGS.map((msg, i) => (
            <span
              key={msg}
              className={[
                styles.statusLine,
                visible > i + 1 ? styles.statusLineDone :
                visible === i + 1 ? styles.statusLineVisible : '',
              ].join(' ')}
            >
              {visible > i + 1 ? `✓ ${msg}` : msg}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Step 3: Review ────────────────────────────────────────────────────────────

function StepReview({
  form, ocrConfidence, fieldConfidences, lineItems,
  voucherTypes, isSubmitting, error,
  companyName, companyGstin,
  onUpdate, onBack, onSubmit,
}: {
  form:              ScanForm
  ocrConfidence:     number
  fieldConfidences:  Record<string, number>
  lineItems:         { description: string; qty: string; rate: string; amount: string; hsn: string }[]
  voucherTypes:      VoucherType[]
  isSubmitting:      boolean
  error:             string | null
  companyName?:      string
  companyGstin?:     string
  onUpdate:          <K extends keyof ScanForm>(key: K, val: ScanForm[K]) => void
  onBack:            () => void
  onSubmit:          () => void
}) {
  const needsReview = ocrConfidence < 75

  const gstBadgeClass =
    form.gstType === 'intra' ? styles.gstBadgeIntra :
    form.gstType === 'inter' ? styles.gstBadgeInter :
    styles.gstBadgeUnknown

  const gstBadgeLabel =
    form.gstType === 'intra' ? 'Intra-state · CGST + SGST' :
    form.gstType === 'inter' ? 'Inter-state · IGST' :
    'GST type unknown — verify GSTINs'

  const suppGstinOk = !form.supplierGstin  || GSTIN_RE.test(form.supplierGstin)
  const recpGstinOk = !form.recipientGstin || GSTIN_RE.test(form.recipientGstin)

  // Which side is "our company" (locked to master data)?
  const isOurSale          = form.voucherType === 'sales'
  const ourSideLocked      = form.ourPartyVerified
  const counterSideMatched = form.counterPartyVerified

  const confKeys = Object.entries(fieldConfidences)
    .sort(([, a], [, b]) => a - b)
    .slice(0, 8)

  const fmtINR = (str: string) =>
    formatIndianCurrency(parseFloat(str) || 0)

  const purchaseTypeId = voucherTypes.find(vt => vt.nature === form.voucherType)?.id ?? voucherTypes[0]?.id

  if (!purchaseTypeId) return null

  return (
    <>
      <div className={styles.body}>
        {error && (
          <div className={styles.errorBanner} role="alert">
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            {error}
          </div>
        )}
        {needsReview && (
          <div className={styles.warnBanner}>
            <AlertTriangle size={14} style={{ flexShrink: 0 }} />
            OCR confidence is below 75%. Review highlighted fields carefully before creating the voucher.
          </div>
        )}

        <div className={styles.reviewGrid}>
          {/* ── LEFT COLUMN ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

            {/* Invoice Details */}
            <div className={styles.card}>
              <p className={styles.cardTitle}>Invoice Details</p>
              <Field label="Invoice No.">
                <input
                  className={styles.input}
                  value={form.invoiceNo}
                  onChange={e => onUpdate('invoiceNo', e.target.value)}
                  aria-label="Invoice number"
                />
              </Field>
              <Field label="Invoice Date">
                <input
                  type="date"
                  className={styles.input}
                  value={form.invoiceDate}
                  onChange={e => onUpdate('invoiceDate', e.target.value)}
                  aria-label="Invoice date"
                />
              </Field>
            </div>

            {/* Parties */}
            <div className={styles.card}>
              <p className={styles.cardTitle}>Parties</p>

              {/* Supplier row — locked if it’s our company on a sale invoice */}
              <Field label="Supplier">
                {ourSideLocked && isOurSale ? (
                  <div className={styles.lockedField}>
                    <input
                      className={`${styles.input} ${styles.inputLocked}`}
                      value={form.supplierName}
                      readOnly
                      aria-label="Supplier name (company master)"
                    />
                    <span className={styles.verifiedBadge}>
                      <Lock size={10} /> Company Master
                    </span>
                  </div>
                ) : (
                  <input
                    className={styles.input}
                    value={form.supplierName}
                    onChange={e => onUpdate('supplierName', e.target.value)}
                    aria-label="Supplier name"
                  />
                )}
              </Field>
              <Field label="Supplier GSTIN">
                {ourSideLocked && isOurSale ? (
                  <div className={styles.lockedField}>
                    <input
                      className={`${styles.input} ${styles.inputMono} ${styles.inputLocked}`}
                      value={form.supplierGstin}
                      readOnly
                      aria-label="Supplier GSTIN (company master)"
                    />
                    <span className={styles.verifiedBadge}>
                      <Lock size={10} /> Company Master
                    </span>
                  </div>
                ) : counterSideMatched && !isOurSale ? (
                  <div className={styles.lockedField}>
                    <input
                      className={`${styles.input} ${styles.inputMono} ${styles.inputLocked}`}
                      value={form.supplierGstin}
                      onChange={e => onUpdate('supplierGstin', e.target.value.toUpperCase())}
                      maxLength={15}
                      aria-label="Supplier GSTIN (matched from entity master)"
                    />
                    <span className={styles.verifiedBadge}>
                      ✓ Entity Master
                    </span>
                  </div>
                ) : (
                  <input
                    className={`${styles.input} ${styles.inputMono} ${!suppGstinOk ? styles.inputError : ''}`}
                    value={form.supplierGstin}
                    onChange={e => onUpdate('supplierGstin', e.target.value.toUpperCase())}
                    maxLength={15}
                    placeholder="22AAAAA0000A1Z5"
                    aria-label="Supplier GSTIN"
                    aria-invalid={!suppGstinOk}
                  />
                )}
              </Field>

              {/* Recipient row — locked if it’s our company on a purchase invoice */}
              <Field label="Recipient">
                {ourSideLocked && !isOurSale ? (
                  <div className={styles.lockedField}>
                    <input
                      className={`${styles.input} ${styles.inputLocked}`}
                      value={form.recipientName}
                      readOnly
                      aria-label="Recipient name (company master)"
                    />
                    <span className={styles.verifiedBadge}>
                      <Lock size={10} /> Company Master
                    </span>
                  </div>
                ) : (
                  <input
                    className={styles.input}
                    value={form.recipientName}
                    onChange={e => onUpdate('recipientName', e.target.value)}
                    aria-label="Recipient name"
                  />
                )}
              </Field>
              <Field label="Recipient GSTIN">
                {ourSideLocked && !isOurSale ? (
                  <div className={styles.lockedField}>
                    <input
                      className={`${styles.input} ${styles.inputMono} ${styles.inputLocked}`}
                      value={form.recipientGstin}
                      readOnly
                      aria-label="Recipient GSTIN (company master)"
                    />
                    <span className={styles.verifiedBadge}>
                      <Lock size={10} /> Company Master
                    </span>
                  </div>
                ) : counterSideMatched && isOurSale ? (
                  <div className={styles.lockedField}>
                    <input
                      className={`${styles.input} ${styles.inputMono} ${styles.inputLocked}`}
                      value={form.recipientGstin}
                      onChange={e => onUpdate('recipientGstin', e.target.value.toUpperCase())}
                      maxLength={15}
                      aria-label="Recipient GSTIN (matched from entity master)"
                    />
                    <span className={styles.verifiedBadge}>
                      ✓ Entity Master
                    </span>
                  </div>
                ) : (
                  <input
                    className={`${styles.input} ${styles.inputMono} ${!recpGstinOk ? styles.inputError : ''}`}
                    value={form.recipientGstin}
                    onChange={e => onUpdate('recipientGstin', e.target.value.toUpperCase())}
                    maxLength={15}
                    placeholder="33AAAAA0000A1Z5"
                    aria-label="Recipient GSTIN"
                    aria-invalid={!recpGstinOk}
                  />
                )}
              </Field>
            </div>

            {/* GST Breakdown */}
            <div className={styles.card}>
              <p className={styles.cardTitle}>GST Breakdown</p>
              <span className={`${styles.gstBadge} ${gstBadgeClass}`}>{gstBadgeLabel}</span>
              <div className={styles.gstRow}>
                <AmtInput id="cgst" label="CGST"      value={form.cgst} onChange={v => onUpdate('cgst', v)} />
                <AmtInput id="sgst" label="SGST/TNGST" value={form.sgst} onChange={v => onUpdate('sgst', v)} />
                <AmtInput id="igst" label="IGST"      value={form.igst} onChange={v => onUpdate('igst', v)} />
              </div>
              <hr className={styles.separator} />
              <div className={styles.summaryRow}>
                <span>Taxable Value</span>
                <span className={styles.summaryAmt}>{fmtINR(form.taxableValue)}</span>
              </div>
              <div className={styles.summaryRow}>
                <span>Total GST</span>
                <span className={styles.summaryAmt}>{fmtINR(form.totalGst)}</span>
              </div>
              <div className={`${styles.summaryRow} ${styles.summaryRowTotal}`}>
                <span>Invoice Total</span>
                <span className={styles.summaryAmtTotal}>{fmtINR(form.totalAmount)}</span>
              </div>
            </div>

            {/* Voucher Settings */}
            <div className={styles.card}>
              <p className={styles.cardTitle}>Voucher Settings</p>
              <Field label="Voucher Type">
                <select
                  className={styles.select}
                  value={form.voucherType}
                  onChange={e => onUpdate('voucherType', e.target.value as ScanForm['voucherType'])}
                  aria-label="Voucher type"
                >
                  {voucherTypes.map(vt => (
                    <option key={vt.id} value={vt.nature}>{vt.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Narration">
                <textarea
                  className={styles.textarea}
                  rows={2}
                  value={form.narration}
                  onChange={e => onUpdate('narration', e.target.value)}
                  aria-label="Narration"
                />
              </Field>
              <div className={styles.toggleRow}>
                <span className={styles.toggleLabel}>ITC Eligible</span>
                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={form.itcEligible}
                    onChange={e => onUpdate('itcEligible', e.target.checked)}
                    aria-label="ITC eligible"
                  />
                  <span className={styles.toggleSlider} />
                </label>
              </div>
            </div>
          </div>

          {/* ── RIGHT COLUMN ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

            {/* OCR Confidence */}
            <div className={styles.card}>
              <p className={styles.cardTitle}>OCR Confidence</p>
              <div className={styles.confidenceScore}>{ocrConfidence.toFixed(1)}%</div>
              <div className={styles.confFieldList}>
                {confKeys.map(([key, val]) => (
                  <div key={key} className={styles.confFieldRow}>
                    <span className={styles.confFieldName}>
                      {key.replace(/_/g, ' ').toLowerCase()}
                    </span>
                    <ConfBar value={val} />
                  </div>
                ))}
              </div>
              {needsReview && (
                <p className={styles.confNote}>Review fields highlighted in amber or red</p>
              )}
            </div>

            {/* Line Items */}
            {lineItems.length > 0 && (
              <div className={styles.card}>
                <p className={styles.cardTitle}>Line Items</p>
                <table className={styles.lineTable}>
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th>HSN</th>
                      <th>Qty</th>
                      <th>Rate</th>
                      <th>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((li, i) => (
                      <tr key={i}>
                        <td>{li.description || '—'}</td>
                        <td>{li.hsn || '—'}</td>
                        <td>{li.qty || '—'}</td>
                        <td>{li.rate || '—'}</td>
                        <td>{li.amount || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={styles.actionBar}>
        <button type="button" className={styles.btnGhost} onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </button>
        <button
          type="button"
          className={styles.btnPrimary}
          disabled={isSubmitting}
          onClick={onSubmit}
        >
          {isSubmitting && <Loader2 size={14} className={styles.spin} />}
          {isSubmitting ? 'Creating…' : 'Create Draft Voucher'}
        </button>
      </div>
    </>
  )
}

// ── Step 4: Done ──────────────────────────────────────────────────────────────

function StepDone({
  draftId, form, ocrResult, onScanAnother,
}: {
  draftId:    string
  form:       ScanForm
  ocrResult:  import('@/hooks/useInvoiceScan').OcrResult
  onScanAnother: () => void
}) {
  const navigate = useNavigate()

  function buildRecord(): VoucherRecord {
    return {
      voucherNo:      draftId.slice(0, 8).toUpperCase(),   // short until real number assigned
      voucherDate:    form.invoiceDate || new Date().toISOString().slice(0, 10),
      voucherType:    form.voucherType,
      nature:         form.voucherType,
      referenceNo:    form.invoiceNo || null,
      supplierName:   form.supplierName || null,
      supplierGstin:  form.supplierGstin || null,
      supplierState:  ocrResult.supplierState || null,
      recipientName:  form.recipientName || null,
      recipientGstin: form.recipientGstin || null,
      recipientState: ocrResult.recipientState || null,
      gstType:        form.gstType,
      hsnCode:        form.hsn || null,
      narration:      form.narration || null,
      taxableValue:   parseFloat(form.taxableValue) || 0,
      cgstAmount:     parseFloat(form.cgst) || 0,
      sgstAmount:     parseFloat(form.sgst) || 0,
      igstAmount:     parseFloat(form.igst) || 0,
      totalGst:       parseFloat(form.totalGst) || 0,
      invoiceTotal:   parseFloat(form.totalAmount) || 0,
      itcEligible:    form.itcEligible,
      ocrConfidence:  ocrResult.confidence,
      status:         'draft',
      createdAt:      new Date().toISOString(),
      lineItems:      ocrResult.lineItems,
    }
  }

  return (
    <div className={styles.body}>
      <div className={styles.doneWrap}>
        <div className={styles.checkCircle} aria-hidden="true">
          <CheckCircle size={32} color="#0F6E56" />
        </div>

        <h2 className={styles.doneTitle}>Draft Voucher Created</h2>
        <p className={styles.doneSub}>
          Add the ledger entries to complete the voucher
        </p>

        <div className={styles.voucherChip}>DRAFT · {draftId.slice(0, 8).toUpperCase()}</div>
        <span className={styles.statusChip}>Draft — entries pending</span>

        <div className={styles.donePrimaryActions}>
          <button
            className={styles.btnPrimary}
            onClick={() => navigate(`/vouchers/${draftId}/edit`)}
          >
            Complete Entries →
          </button>
          <button className={styles.btnSecondary} onClick={onScanAnother}>
            Scan Another
          </button>
        </div>

        <div className={styles.doneExportActions}>
          <button
            className={styles.btnExport}
            onClick={() => exportVoucherCsv(buildRecord(), 'summary')}
          >
            <Download size={13} /> Summary CSV
          </button>
          <button
            className={styles.btnExport}
            onClick={() => {
              const r = buildRecord()
              if (r.lineItems.length === 0) {
                toast.info('No line items extracted — exporting summary instead')
                exportVoucherCsv(r, 'summary')
              } else {
                exportVoucherCsv(r, 'lineitems')
              }
            }}
          >
            <Download size={13} /> Line Items CSV
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────────────────────

export default function InvoiceScanModal({
  open, onClose, companyId, userId, companyGstin = '', companyName = '', voucherTypes,
}: Props) {
  const { state, selectFile, startScan, updateField, submitVoucher, reset } = useInvoiceScan({ companyGstin, companyName })
  const modalRef = useRef<HTMLDivElement>(null)

  // Focus trap + ESC handler
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null

    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (state.step === 3) {
        if (window.confirm('Leave review? Your extracted data will be lost.')) {
          reset(); onClose()
        }
      } else {
        reset(); onClose()
      }
    }

    document.addEventListener('keydown', onKey)
    modalRef.current?.focus()

    return () => {
      document.removeEventListener('keydown', onKey)
      prev?.focus()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state.step])

  // Keep body scroll locked
  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  function handleClose() {
    if (state.step === 3) {
      if (!window.confirm('Leave review? Your extracted data will be lost.')) return
    }
    reset(); onClose()
  }

  function handleSelectFile(file: File | null) {
    if (file === null) reset()   // clear file
    else selectFile(file)
  }

  function handleScan() {
    if (state.file) startScan(state.file)
  }

  function handleSubmit() {
    const vtNature  = state.form.voucherType
    const vt        = voucherTypes.find(t => t.nature === vtNature) ?? voucherTypes[0]
    if (!vt) { toast.error('No matching voucher type found'); return }
    submitVoucher(companyId, vt.id, userId, state.ocrResult?.confidence ?? null)
  }

  function handleBack() {
    reset()
  }

  const { step, file, previewUrl, isProcessing, ocrResult, form, error, isSubmitting, draftId } = state

  return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && handleClose()}>
      <div
        className={styles.modal}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Scan Invoice"
        tabIndex={-1}
      >
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.headerTitle}>Scan Invoice</h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={handleClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Stepper */}
        <Stepper current={step} />

        {/* Steps */}
        {step === 1 && (
          <StepUpload
            file={file}
            previewUrl={previewUrl}
            error={error}
            onFile={handleSelectFile}
            onScan={handleScan}
          />
        )}

        {(step === 2 || isProcessing) && <StepProcessing />}

        {step === 3 && ocrResult && (
          <StepReview
            form={form}
            ocrConfidence={ocrResult.confidence}
            fieldConfidences={ocrResult.fieldConfidences}
            lineItems={ocrResult.lineItems}
            voucherTypes={voucherTypes}
            isSubmitting={isSubmitting}
            error={error}
            companyName={companyName}
            companyGstin={companyGstin}
            onUpdate={updateField}
            onBack={handleBack}
            onSubmit={handleSubmit}
          />
        )}

        {step === 4 && draftId && ocrResult && (
          <StepDone
            draftId={draftId}
            form={form}
            ocrResult={ocrResult}
            onScanAnother={() => { reset(); }}
          />
        )}
      </div>
    </div>
  )
}
