import { useState }    from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ChevronLeft, FileText, Receipt, XCircle, CheckCircle, ExternalLink } from 'lucide-react'
import { toast }          from 'sonner'
import { useAuth }        from '@/contexts/AuthContext'
import { supabase }       from '@/lib/supabase'
import {
  useInvoiceScanDetail,
  updateScanStatus,
  type ScanStatus,
} from './hooks/useInvoiceScans'
import ScanLineItemsTable from './ScanLineItemsTable'
import CreateVoucherButton from './CreateVoucherButton'
import css from './ScanDetail.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function fmtAmount(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 2,
  }).format(n)
}

function StatusBadge({ status }: { status: ScanStatus }) {
  const map: Record<ScanStatus, { label: string; cls: string }> = {
    pending:         { label: 'Pending',        cls: css.badgePending  },
    reviewed:        { label: 'Reviewed',        cls: css.badgeReviewed },
    voucher_created: { label: 'Voucher Created', cls: css.badgeCreated  },
    rejected:        { label: 'Rejected',        cls: css.badgeRejected },
  }
  const { label, cls } = map[status] ?? { label: status, cls: css.badgePending }
  return <span className={`${css.badge} ${cls}`}>{label}</span>
}

function ConfBadge({ conf }: { conf: number | null }) {
  if (conf === null || conf === 0) return null
  const pct = Math.round(conf * 100)
  const cls = pct >= 85 ? css.confHigh : pct >= 65 ? css.confMedium : css.confLow
  return (
    <div className={css.confRow}>
      <span className={css.confLabel}>OCR Confidence:</span>
      <span className={`${css.confBadge} ${cls}`}>{pct}%</span>
    </div>
  )
}

function GstTag({ type }: { type: string | null }) {
  if (!type || type === 'unknown') return <span className={`${css.gstTag} ${css.gstUnk}`}>Unknown</span>
  if (type === 'intra') return <span className={`${css.gstTag} ${css.gstIntra}`}>Intra-state (CGST+SGST)</span>
  return <span className={`${css.gstTag} ${css.gstInter}`}>Inter-state (IGST)</span>
}

// ── Storage URL helper ─────────────────────────────────────────────────────────

async function getStorageUrl(path: string) {
  const { data } = await supabase.storage.from('bill-attachments').createSignedUrl(path, 3600)
  return data?.signedUrl ?? null
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ScanDetail() {
  const { id }    = useParams<{ id: string }>()
  const { user }  = useAuth()
  const navigate  = useNavigate()
  const userId    = user?.id ?? ''

  const { scan, items, loading, error, refresh } = useInvoiceScanDetail(id ?? '')
  const [saving, setSaving] = useState(false)

  const handleReview = async () => {
    if (!scan) return
    setSaving(true)
    const { error: err } = await updateScanStatus(scan.id, 'reviewed', userId)
    setSaving(false)
    if (err) { toast.error(err); return }
    toast.success('Marked as reviewed.')
    refresh()
  }

  const handleReject = async () => {
    if (!scan) return
    if (!window.confirm('Reject this scan? It will be marked as rejected.')) return
    setSaving(true)
    const { error: err } = await updateScanStatus(scan.id, 'rejected', userId)
    setSaving(false)
    if (err) { toast.error(err); return }
    toast.success('Scan rejected.')
    refresh()
  }

  const handleViewOriginal = async () => {
    if (!scan?.storage_path) return
    const url = await getStorageUrl(scan.storage_path)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
    else toast.error('Could not generate file URL.')
  }

  if (loading) {
    return (
      <div className={css.loading}>
        <div className={css.spinner} />
        Loading scan…
      </div>
    )
  }

  if (error || !scan) {
    return <div className={css.errorBox}>{error ?? 'Scan not found.'}</div>
  }

  const isDone    = scan.status === 'voucher_created' || scan.status === 'rejected'
  const isCreated = scan.status === 'voucher_created'

  return (
    <div className={css.wrap}>
      {/* Back */}
      <button className={css.backBtn} onClick={() => navigate('/invoices/inbox')}>
        <ChevronLeft size={15} /> Invoice Inbox
      </button>

      {/* Header */}
      <div className={css.headerRow}>
        <div className={css.headingGroup}>
          <h1 className={css.heading}>
            {scan.type === 'purchase' ? 'Purchase' : 'Sales'} Invoice
            {scan.invoice_no ? ` — ${scan.invoice_no}` : ''}
          </h1>
          <p className={css.scanRef}>{scan.scan_ref}</p>
        </div>
        <StatusBadge status={scan.status} />
      </div>

      <ConfBadge conf={scan.confidence} />

      {/* ── Header fields ───────────────────────────────────────────────── */}
      <div className={css.section}>
        <div className={css.sectionHead}>Invoice Details</div>
        <div className={css.sectionBody}>
          <div className={css.fieldGrid}>
            <div className={css.fieldItem}>
              <span className={css.fieldLabel}>Invoice Date</span>
              <span className={css.fieldValue}>{fmtDate(scan.invoice_date)}</span>
            </div>
            <div className={css.fieldItem}>
              <span className={css.fieldLabel}>Invoice No</span>
              <span className={css.fieldValueMono}>{scan.invoice_no ?? '—'}</span>
            </div>
            <div className={css.fieldItem}>
              <span className={css.fieldLabel}>Party Name</span>
              <span className={css.fieldValue}>{scan.party_name ?? '—'}</span>
            </div>
            <div className={css.fieldItem}>
              <span className={css.fieldLabel}>Party GSTIN</span>
              <span className={css.fieldValueMono}>{scan.party_gstin ?? '—'}</span>
            </div>
            <div className={css.fieldItem}>
              <span className={css.fieldLabel}>Our GSTIN</span>
              <span className={css.fieldValueMono}>{scan.our_gstin ?? '—'}</span>
            </div>
            <div className={css.fieldItem}>
              <span className={css.fieldLabel}>GST Type</span>
              <GstTag type={scan.gst_type ?? null} />
            </div>
          </div>
        </div>
      </div>

      {/* ── Amounts ─────────────────────────────────────────────────────── */}
      <div className={css.section}>
        <div className={css.sectionHead}>Amounts</div>
        <div className={css.sectionBody}>
          <div className={css.fieldGrid}>
            <div className={css.fieldItem}>
              <span className={css.fieldLabel}>Taxable Value</span>
              <span className={css.fieldValueMono}>{fmtAmount(scan.taxable_value)}</span>
            </div>
            <div className={css.fieldItem}>
              <span className={css.fieldLabel}>CGST</span>
              <span className={css.fieldValueMono}>{fmtAmount(scan.cgst)}</span>
            </div>
            <div className={css.fieldItem}>
              <span className={css.fieldLabel}>SGST</span>
              <span className={css.fieldValueMono}>{fmtAmount(scan.sgst)}</span>
            </div>
            <div className={css.fieldItem}>
              <span className={css.fieldLabel}>IGST</span>
              <span className={css.fieldValueMono}>{fmtAmount(scan.igst)}</span>
            </div>
            <div className={css.fieldItem}>
              <span className={css.fieldLabel}>Total GST</span>
              <span className={css.fieldValueMono}>{fmtAmount(scan.total_gst)}</span>
            </div>
            <div className={css.fieldItem}>
              <span className={css.fieldLabel}>Total Amount</span>
              <span className={css.fieldValueMono} style={{ fontWeight: 700, fontSize: '1rem' }}>
                {fmtAmount(scan.total_amount)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Line items ──────────────────────────────────────────────────── */}
      <div className={css.section}>
        <div className={css.sectionHead}>Line Items {items.length > 0 ? `(${items.length})` : ''}</div>
        <div className={css.sectionBody} style={{ padding: 0 }}>
          <ScanLineItemsTable
            items={items}
            readOnly={isDone}
            onUpdate={refresh}
          />
        </div>
      </div>

      {/* ── Original file ──────────────────────────────────────────────── */}
      {scan.storage_path && (
        <div className={css.section}>
          <div className={css.sectionHead}>Original File</div>
          <div className={css.sectionBody}>
            <button className={css.attachLink} onClick={handleViewOriginal}>
              <FileText size={14} />
              {scan.storage_path.split('/').pop()}
              <ExternalLink size={12} />
            </button>
          </div>
        </div>
      )}

      {/* ── Actions ─────────────────────────────────────────────────────── */}
      {!isDone && (
        <div className={css.actions}>
          <CreateVoucherButton scan={scan} onCreated={refresh} />

          {scan.status === 'pending' && (
            <button
              className={css.btnSecondary}
              onClick={handleReview}
              disabled={saving}
            >
              <CheckCircle size={15} />
              Mark Reviewed
            </button>
          )}

          <button
            className={css.btnDanger}
            onClick={handleReject}
            disabled={saving}
          >
            <XCircle size={15} />
            Reject
          </button>
        </div>
      )}

      {/* ── Voucher link (when created) ─────────────────────────────────── */}
      {isCreated && scan.voucher_id && (
        <div className={css.actions}>
          <Link
            to={`/vouchers/${scan.voucher_id}/edit`}
            className={css.voucherLink}
          >
            <Receipt size={15} />
            View Voucher
            <ExternalLink size={12} />
          </Link>
        </div>
      )}
    </div>
  )
}
