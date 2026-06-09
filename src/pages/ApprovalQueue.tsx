import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CheckCircle2, XCircle, Loader2, X, ChevronRight,
  Clock, CheckCircle, AlertCircle, Paperclip,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import { useApprovalCount } from '@/contexts/ApprovalContext'
import {
  fetchPendingVouchers,
  fetchVoucherFull,
  approveVoucher,
  rejectVoucher,
  type PendingVoucher,
  type VoucherFull,
  type VoucherEntryDetail,
  type ApprovalHistoryItem,
} from '@/lib/approvals'
import { formatIndianCurrency } from '@/lib/vouchers'
import styles from './ApprovalQueue.module.css'

// ── Constants ─────────────────────────────────────────────────────────────────

const NATURE_COLOR: Record<string, string> = {
  payment:  '#e05252',
  receipt:  '#4caf7d',
  journal:  '#4a9e9e',
  contra:   '#c9a84c',
  purchase: '#e07844',
  sales:    '#7b9fe0',
}

const APPROVAL_ROLES = new Set(['admin', 'accounts', 'auditor'])

// ── Date helpers ──────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className={styles.emptyState}>
      <CheckCircle2 size={44} className={styles.emptyIcon} />
      <p className={styles.emptyText}>No vouchers pending approval. All clear.</p>
    </div>
  )
}

// ── Voucher list row ──────────────────────────────────────────────────────────

function VoucherRow({
  voucher,
  selected,
  onClick,
}: {
  voucher: PendingVoucher
  selected: boolean
  onClick: () => void
}) {
  const color = NATURE_COLOR[voucher.voucher_type.nature] ?? 'var(--text-muted)'
  return (
    <tr
      className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
      onClick={onClick}
    >
      <td className={styles.voucherNo}>{voucher.voucher_number}</td>
      <td>
        <span
          className={styles.typeBadge}
          style={{ background: `${color}18`, color, borderColor: `${color}50` }}
        >
          {voucher.voucher_type.code}
        </span>
      </td>
      <td>{fmtDate(voucher.voucher_date)}</td>
      <td className={styles.partyCell}>
        {voucher.entity_name ?? <span className={styles.dim}>—</span>}
      </td>
      <td className={styles.amountCell}>{formatIndianCurrency(voucher.amount)}</td>
      <td>{voucher.created_by_name}</td>
      <td className={styles.dim}>{fmtDateTime(voucher.created_at)}</td>
      <td>
        <ChevronRight
          size={14}
          className={`${styles.chevron} ${selected ? styles.chevronActive : ''}`}
        />
      </td>
    </tr>
  )
}

// ── Entries table (inside panel) ──────────────────────────────────────────────

function EntriesTable({ entries }: { entries: VoucherEntryDetail[] }) {
  const drTotal = entries.reduce((s, e) => e.entry_type === 'Dr' ? s + e.amount : s, 0)
  const crTotal = entries.reduce((s, e) => e.entry_type === 'Cr' ? s + e.amount : s, 0)
  const balanced = Math.round(drTotal * 100) === Math.round(crTotal * 100)

  return (
    <div className={styles.entryTableWrap}>
      <table className={styles.entryTable}>
        <thead>
          <tr>
            <th>Ledger</th>
            <th>Group</th>
            <th className={styles.right}>Dr</th>
            <th className={styles.right}>Cr</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(e => (
            <tr key={e.id}>
              <td className={styles.ledgerName}>{e.ledger_name}</td>
              <td className={styles.groupName}>{e.group_name ?? '—'}</td>
              <td className={`${styles.right} ${styles.mono}`}>
                {e.entry_type === 'Dr' ? formatIndianCurrency(e.amount) : ''}
              </td>
              <td className={`${styles.right} ${styles.mono}`}>
                {e.entry_type === 'Cr' ? formatIndianCurrency(e.amount) : ''}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className={styles.entryTotals}>
            <td colSpan={2}>
              <span className={`${styles.balanceBadge} ${balanced ? styles.balancedBadge : styles.unbalancedBadge}`}>
                {balanced
                  ? <><CheckCircle size={11} /> Balanced</>
                  : <><AlertCircle size={11} /> Unbalanced</>
                }
              </span>
            </td>
            <td className={`${styles.right} ${styles.mono} ${styles.totalCell}`}>
              {formatIndianCurrency(drTotal)}
            </td>
            <td className={`${styles.right} ${styles.mono} ${styles.totalCell}`}>
              {formatIndianCurrency(crTotal)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── Approval history timeline ─────────────────────────────────────────────────

function HistoryTimeline({
  submittedAt,
  submittedBy,
  history,
}: {
  submittedAt: string
  submittedBy: string
  history: ApprovalHistoryItem[]
}) {
  const allItems: ApprovalHistoryItem[] = [
    {
      id: '__submitted',
      action: 'submitted',
      actioned_by_name: submittedBy,
      comments: null,
      actioned_at: submittedAt,
    },
    ...history,
  ]

  const ICON: Record<string, React.ReactNode> = {
    submitted: <Clock size={13} />,
    approved:  <CheckCircle size={13} />,
    rejected:  <XCircle size={13} />,
  }
  const COLOR: Record<string, string> = {
    submitted: 'var(--text-muted)',
    approved:  'var(--success)',
    rejected:  'var(--error)',
  }
  const LABEL: Record<string, string> = {
    submitted: 'Submitted for approval',
    approved:  'Approved & posted',
    rejected:  'Rejected — returned to draft',
  }

  return (
    <div className={styles.timeline}>
      {allItems.map((item, idx) => {
        const color = COLOR[item.action] ?? 'var(--text-muted)'
        const isLast = idx === allItems.length - 1
        return (
          <div key={item.id} className={styles.timelineItem}>
            <div className={styles.timelineLeft}>
              <div
                className={styles.timelineDot}
                style={{ background: `${color}22`, border: `1.5px solid ${color}`, color }}
              >
                {ICON[item.action]}
              </div>
              {!isLast && <div className={styles.timelineLine} />}
            </div>
            <div className={styles.timelineContent}>
              <div className={styles.timelineRow}>
                <span className={styles.timelineAction} style={{ color }}>
                  {LABEL[item.action] ?? item.action}
                </span>
                <span className={styles.timelineTime}>{fmtDateTime(item.actioned_at)}</span>
              </div>
              <div className={styles.timelineActor}>{item.actioned_by_name}</div>
              {item.comments && (
                <div className={styles.timelineComment}>"{item.comments}"</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Detail panel ──────────────────────────────────────────────────────────────

interface DetailPanelProps {
  voucher:      VoucherFull | null
  loading:      boolean
  canApprove:   boolean
  companyId:    string
  userId:       string
  onClose:      () => void
  onActionDone: (voucherId: string) => void
}

function DetailPanel({
  voucher, loading, canApprove, companyId, userId, onClose, onActionDone,
}: DetailPanelProps) {
  const [approvalNote,   setApprovalNote]   = useState('')
  const [rejectReason,   setRejectReason]   = useState('')
  const [rejectError,    setRejectError]    = useState('')
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [acting,         setActing]         = useState(false)

  useEffect(() => {
    setApprovalNote('')
    setRejectReason('')
    setRejectError('')
    setShowRejectForm(false)
  }, [voucher?.id])

  const handleApprove = async () => {
    if (!voucher) return
    setActing(true)
    try {
      await approveVoucher(voucher.id, companyId, userId, approvalNote.trim() || null)
      toast.success('Voucher posted successfully')
      onActionDone(voucher.id)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Approval failed')
    } finally {
      setActing(false)
    }
  }

  const handleReject = async () => {
    if (!voucher) return
    if (!rejectReason.trim()) { setRejectError('Rejection reason is required'); return }
    setActing(true)
    try {
      await rejectVoucher(voucher.id, companyId, userId, rejectReason.trim())
      toast.success('Voucher returned to draft')
      onActionDone(voucher.id)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Rejection failed')
    } finally {
      setActing(false)
    }
  }

  const color = voucher ? (NATURE_COLOR[voucher.voucher_type.nature] ?? 'var(--teal)') : 'var(--teal)'

  return (
    <div className={styles.panelInner}>

      {/* Header */}
      <div className={styles.panelHeader}>
        <div className={styles.panelHeaderLeft}>
          {voucher ? (
            <>
              <span className={styles.panelVoucherNo}>{voucher.voucher_number}</span>
              <span
                className={styles.panelTypeBadge}
                style={{ background: `${color}18`, color, borderColor: `${color}50` }}
              >
                {voucher.voucher_type.name}
              </span>
            </>
          ) : (
            <div className={styles.panelTitlePlaceholder} />
          )}
        </div>
        <button className={styles.closeBtn} onClick={onClose} aria-label="Close panel">
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div className={styles.panelBody}>
        {loading ? (
          <div className={styles.panelLoading}>
            <Loader2 size={22} className={styles.spin} />
          </div>
        ) : !voucher ? null : (
          <>
            {/* Section 1 — Voucher header details */}
            <div className={styles.detailSection}>
              <h3 className={styles.detailSectionTitle}>Voucher Details</h3>
              <dl className={styles.detailGrid}>
                <dt>Date</dt>
                <dd>{fmtDate(voucher.voucher_date)}</dd>

                <dt>Amount</dt>
                <dd className={styles.mono}>{formatIndianCurrency(voucher.amount)}</dd>

                {voucher.entity_name && <>
                  <dt>Party</dt>
                  <dd>{voucher.entity_name}</dd>
                </>}

                {voucher.payment_mode && <>
                  <dt>Payment Mode</dt>
                  <dd style={{ textTransform: 'capitalize' }}>{voucher.payment_mode}</dd>
                </>}

                {voucher.bank_ledger_name && <>
                  <dt>Bank Account</dt>
                  <dd>{voucher.bank_ledger_name}</dd>
                </>}

                {voucher.cheque_number && <>
                  <dt>Cheque No.</dt>
                  <dd>
                    {voucher.cheque_number}
                    {voucher.cheque_date ? ` · ${fmtDate(voucher.cheque_date)}` : ''}
                  </dd>
                </>}

                {voucher.utr_number && <>
                  <dt>UTR / Ref</dt>
                  <dd>{voucher.utr_number}</dd>
                </>}

                {voucher.ref_document_number && <>
                  <dt>Reference</dt>
                  <dd>{voucher.ref_document_number}</dd>
                </>}

                {voucher.cost_centre_name && <>
                  <dt>Cost Centre</dt>
                  <dd>{voucher.cost_centre_name}</dd>
                </>}

                {voucher.narration && <>
                  <dt>Narration</dt>
                  <dd className={styles.narrationValue}>{voucher.narration}</dd>
                </>}
              </dl>
            </div>

            {/* Section 2 — Accounting entries */}
            <div className={styles.detailSection}>
              <h3 className={styles.detailSectionTitle}>Accounting Entries</h3>
              {voucher.entries.length === 0
                ? <p className={styles.detailEmpty}>No entries found</p>
                : <EntriesTable entries={voucher.entries} />
              }
            </div>

            {/* Section 3 — Approval history */}
            <div className={styles.detailSection}>
              <h3 className={styles.detailSectionTitle}>History</h3>
              <HistoryTimeline
                submittedAt={voucher.created_at}
                submittedBy={voucher.created_by_name}
                history={voucher.history}
              />
            </div>

            {/* Section 4 — Attachments (Phase 2 placeholder) */}
            <div className={styles.detailSection}>
              <h3 className={styles.detailSectionTitle}>Attachments</h3>
              <div className={styles.attachmentsPlaceholder}>
                <Paperclip size={13} />
                <span>No attachments · Bill attachment coming in Phase 2</span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Footer — approve / reject actions (admin + super_admin only) */}
      {canApprove && voucher && !loading && (
        <div className={styles.panelFooter}>
          {showRejectForm ? (
            <div className={styles.rejectForm}>
              <label className={styles.footerLabel}>
                Rejection reason <span className={styles.req}>*</span>
              </label>
              <textarea
                className={`${styles.rejectTextarea} ${rejectError ? styles.rejectTextareaError : ''}`}
                rows={2}
                value={rejectReason}
                onChange={e => { setRejectReason(e.target.value); setRejectError('') }}
                placeholder="Describe the issue with this voucher…"
              />
              {rejectError && <p className={styles.rejectError}>{rejectError}</p>}
              <div className={styles.rejectActions}>
                <button
                  type="button"
                  className={styles.btnCancel}
                  onClick={() => { setShowRejectForm(false); setRejectReason(''); setRejectError('') }}
                  disabled={acting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.btnReject}
                  onClick={handleReject}
                  disabled={acting}
                >
                  {acting ? <Loader2 size={13} className={styles.spin} /> : <XCircle size={13} />}
                  Confirm Reject
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className={styles.approvalNoteWrap}>
                <label className={styles.footerLabel}>
                  Approval note&nbsp;
                  <span className={styles.labelOpt}>(optional)</span>
                </label>
                <input
                  className={styles.approvalNoteInput}
                  value={approvalNote}
                  onChange={e => setApprovalNote(e.target.value)}
                  placeholder="e.g. Verified against bill no. 123"
                />
              </div>
              <div className={styles.actionBtns}>
                <button
                  type="button"
                  className={styles.btnRejectOutline}
                  onClick={() => setShowRejectForm(true)}
                  disabled={acting}
                >
                  <XCircle size={14} /> Reject
                </button>
                <button
                  type="button"
                  className={styles.btnApprove}
                  onClick={handleApprove}
                  disabled={acting}
                >
                  {acting
                    ? <Loader2 size={14} className={styles.spin} />
                    : <CheckCircle size={14} />
                  }
                  Approve &amp; Post
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ApprovalQueue() {
  const { user }         = useAuth()
  const navigate         = useNavigate()
  const { refreshCount } = useApprovalCount()

  const companyId    = user?.activeCompany?.id   ?? ''
  const userId       = user?.id                  ?? ''
  const role         = user?.activeRole
  const isSuperAdmin = user?.profile.is_super_admin ?? false
  const canApprove   = isSuperAdmin || role === 'admin'

  // Access guard — viewers are blocked at the route level, but double-check here
  useEffect(() => {
    if (!user) return
    const allowed = isSuperAdmin || (role !== null && APPROVAL_ROLES.has(role ?? ''))
    if (!allowed) navigate('/', { replace: true })
  }, [user, role, isSuperAdmin, navigate])

  const [vouchers,      setVouchers]      = useState<PendingVoucher[]>([])
  const [loading,       setLoading]       = useState(true)
  const [selectedId,    setSelectedId]    = useState<string | null>(null)
  const [fullVoucher,   setFullVoucher]   = useState<VoucherFull | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [panelOpen,     setPanelOpen]     = useState(false)

  const loadVouchers = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const data = await fetchPendingVouchers(companyId)
      setVouchers(data)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load approval queue')
    } finally {
      setLoading(false)
    }
  }, [companyId])

  useEffect(() => { loadVouchers() }, [loadVouchers])

  const openDetail = async (id: string) => {
    setSelectedId(id)
    setPanelOpen(true)
    setFullVoucher(null)
    setLoadingDetail(true)
    try {
      const data = await fetchVoucherFull(id)
      setFullVoucher(data)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load voucher detail')
    } finally {
      setLoadingDetail(false)
    }
  }

  const closePanel = () => {
    setPanelOpen(false)
    setSelectedId(null)
    setFullVoucher(null)
  }

  const handleActionDone = (voucherId: string) => {
    setVouchers(prev => prev.filter(v => v.id !== voucherId))
    refreshCount(companyId)
    closePanel()
  }

  return (
    <div className={styles.page}>

      {/* Page header */}
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Approval Queue</h1>
        {!loading && (
          <p className={styles.pageSubtitle}>
            {vouchers.length === 0
              ? 'All vouchers reviewed'
              : `${vouchers.length} voucher${vouchers.length !== 1 ? 's' : ''} pending`}
          </p>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className={styles.loadingPage}>
          <Loader2 size={24} className={styles.spin} />
        </div>
      ) : vouchers.length === 0 ? (
        <EmptyState />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Voucher No.</th>
                <th>Type</th>
                <th>Date</th>
                <th>Party</th>
                <th className={styles.right}>Amount</th>
                <th>Submitted by</th>
                <th>Submitted at</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {vouchers.map(v => (
                <VoucherRow
                  key={v.id}
                  voucher={v}
                  selected={v.id === selectedId}
                  onClick={() => openDetail(v.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Backdrop */}
      {panelOpen && <div className={styles.backdrop} onClick={closePanel} />}

      {/* Slide-over panel — always in DOM so CSS transition works */}
      <aside className={`${styles.slideOver} ${panelOpen ? styles.slideOverOpen : ''}`}>
        <DetailPanel
          voucher={fullVoucher}
          loading={loadingDetail}
          canApprove={canApprove}
          companyId={companyId}
          userId={userId}
          onClose={closePanel}
          onActionDone={handleActionDone}
        />
      </aside>

    </div>
  )
}
