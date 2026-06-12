import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus, Search, X, ChevronRight, Loader2, CheckCircle, Clock, XCircle,
  AlertCircle, FileText, ExternalLink, Trash2, Edit3, Send, RotateCcw, BookOpen, MessageCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchVoucherFull,
  type VoucherFull,
  type VoucherEntryDetail,
  type ApprovalHistoryItem,
} from '@/lib/approvals'
import {
  fetchVouchers,
  recallVoucher,
  deleteVoucher,
  submitDraftVoucher,
  type RegisterVoucher,
  type RegisterFilters,
} from '@/lib/vouchers-list'
import {
  fetchVoucherAttachments,
  isImage,
  formatFileSize,
  type AttachmentWithUrl,
} from '@/lib/attachments'
import { formatIndianCurrency } from '@/lib/vouchers'
import styles from './VoucherRegister.module.css'

// ── WhatsApp payment confirmation URL builder ─────────────────────────────────

function buildPaymentConfirmedWhatsApp(
  mobile: string,
  name: string,
  amount: number,
  companyCode: string,
  narration: string | null,
): string {
  const digits = mobile.replace(/\D/g, '')
  const amtStr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount)
  const narrationLine = narration ? `\nRef: ${narration}` : ''
  const msg =
    `\u{1F9FE} *Relish Accounts \u2014 Payment Confirmation*\n\n` +
    `Hi ${name},\n\n` +
    `Your payment of *${amtStr}* from ${companyCode} has been processed.${narrationLine}\n\n` +
    `\u2014 Relish Accounts`
  return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`
}

// ── Constants ─────────────────────────────────────────────────────────────────

const NATURE_COLOR: Record<string, string> = {
  payment:  '#e05252',
  receipt:  '#4caf7d',
  journal:  '#4a9e9e',
  contra:   '#c9a84c',
  purchase: '#e07844',
  sales:    '#7b9fe0',
}

const STATUS_PILLS = [
  { label: 'All',       value: '' },
  { label: 'Draft',     value: 'draft' },
  { label: 'Pending',   value: 'pending_approval' },
  { label: 'Posted',    value: 'posted' },
  { label: 'Cancelled', value: 'cancelled' },
]

const NATURE_PILLS = [
  { label: 'All',      value: '' },
  { label: 'Payment',  value: 'payment' },
  { label: 'Receipt',  value: 'receipt' },
  { label: 'Journal',  value: 'journal' },
  { label: 'Contra',   value: 'contra' },
  { label: 'Purchase', value: 'purchase' },
  { label: 'Sales',    value: 'sales' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function defaultFilters(): RegisterFilters {
  const today = new Date()
  const first = new Date(today.getFullYear(), today.getMonth(), 1)
  return {
    status:   '',
    nature:   '',
    dateFrom: first.toISOString().slice(0, 10),
    dateTo:   today.toISOString().slice(0, 10),
    search:   '',
  }
}

// ── StatusBadge ───────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'draft':
      return <span className={`${styles.badge} ${styles.badgeDraft}`}>Draft</span>
    case 'pending_approval':
      return (
        <span className={`${styles.badge} ${styles.badgePending}`}>
          <span className={styles.pulseDot} />
          Pending
        </span>
      )
    case 'posted':
      return <span className={`${styles.badge} ${styles.badgePosted}`}>Posted</span>
    case 'cancelled':
      return <span className={`${styles.badge} ${styles.badgeCancelled}`}>Cancelled</span>
    default:
      return <span className={`${styles.badge} ${styles.badgeDraft}`}>{status}</span>
  }
}

// ── TypeBadge ─────────────────────────────────────────────────────────────────

function TypeBadge({ nature, code }: { nature: string; code: string }) {
  const color = NATURE_COLOR[nature] ?? 'var(--text-muted)'
  return (
    <span
      className={styles.typeBadge}
      style={{ background: `${color}18`, color, borderColor: `${color}50` }}
    >
      {code}
    </span>
  )
}

// ── VoucherRow ────────────────────────────────────────────────────────────────

function VoucherRow({
  voucher, selected, onClick,
}: { voucher: RegisterVoucher; selected: boolean; onClick: () => void }) {
  return (
    <tr
      className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
      onClick={onClick}
    >
      <td className={styles.voucherNo}>{voucher.voucher_number}</td>
      <td>
        <TypeBadge nature={voucher.voucher_type.nature} code={voucher.voucher_type.code} />
      </td>
      <td className={styles.dateCell}>{fmtDate(voucher.voucher_date)}</td>
      <td className={styles.partyCell}>
        {voucher.entity_name ?? <span className={styles.dim}>—</span>}
      </td>
      <td className={`${styles.amountCell} ${styles.right}`}>
        {formatIndianCurrency(voucher.amount)}
      </td>
      <td><StatusBadge status={voucher.status} /></td>
      <td className={styles.dim}>{voucher.created_by_name}</td>
      <td>
        <ChevronRight
          size={14}
          className={`${styles.chevron} ${selected ? styles.chevronActive : ''}`}
        />
      </td>
    </tr>
  )
}

// ── EntriesTable ──────────────────────────────────────────────────────────────

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

// ── HistoryTimeline ───────────────────────────────────────────────────────────

function HistoryTimeline({
  submittedAt, submittedBy, history,
}: { submittedAt: string; submittedBy: string; history: ApprovalHistoryItem[] }) {
  const allItems: ApprovalHistoryItem[] = [
    { id: '__submitted', action: 'submitted', actioned_by_name: submittedBy, comments: null, actioned_at: submittedAt },
    ...history,
  ]
  const ICON: Record<string, React.ReactNode> = {
    submitted: <Clock size={12} />,
    approved:  <CheckCircle size={12} />,
    rejected:  <XCircle size={12} />,
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
        const color  = COLOR[item.action] ?? 'var(--text-muted)'
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
  row:         RegisterVoucher | null
  detail:      VoucherFull | null
  loading:     boolean
  attachments: AttachmentWithUrl[]
  companyId:   string
  companyCode: string
  userId:      string
  role:        string | null
  onClose:     () => void
  onRefresh:   () => void
}

function DetailPanel({
  row, detail, loading, attachments,
  companyId, companyCode, userId, role,
  onClose, onRefresh,
}: DetailPanelProps) {
  const navigate = useNavigate()
  const [actioning,      setActioning]      = useState(false)
  const [confirmDelete,  setConfirmDelete]  = useState(false)

  const isAdmin   = role === 'admin' || role === 'super_admin'
  const isAuditor = role === 'auditor'
  const canRecall = row && (row.created_by === userId || isAdmin)

  // Reset confirm state when panel changes
  useEffect(() => { setConfirmDelete(false) }, [row?.id])

  const handleRecall = async () => {
    if (!row) return
    setActioning(true)
    try {
      await recallVoucher(row.id)
      toast.success('Voucher recalled to draft')
      onRefresh(); onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to recall')
    } finally { setActioning(false) }
  }

  const handleDelete = async () => {
    if (!row) return
    setActioning(true)
    try {
      await deleteVoucher(row.id)
      toast.success('Voucher deleted')
      onRefresh(); onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete')
    } finally { setActioning(false); setConfirmDelete(false) }
  }

  const handleSubmitDraft = async () => {
    if (!row) return
    setActioning(true)
    try {
      await submitDraftVoucher(row.id, companyId, companyCode, row.voucher_type.prefix)
      toast.success('Voucher submitted for approval')
      onRefresh(); onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit')
    } finally { setActioning(false) }
  }

  return (
    <aside className={`${styles.panel} ${row ? styles.panelOpen : ''}`}>
      {/* Header */}
      <div className={styles.panelHeader}>
        <div className={styles.panelHeaderLeft}>
          <span className={styles.panelVoucherNo}>{row?.voucher_number ?? '—'}</span>
          {row && <StatusBadge status={row.status} />}
        </div>
        <button className={styles.panelClose} onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      {loading ? (
        <div className={styles.panelLoading}><Loader2 size={24} className={styles.spin} /></div>
      ) : !detail ? null : (
        <div className={styles.panelBody}>

          {/* ── Meta ──────────────────────────────────────────────── */}
          <div className={styles.panelSection}>
            <div className={styles.metaGrid}>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Date</span>
                <span className={styles.metaValue}>{fmtDate(detail.voucher_date)}</span>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Type</span>
                <span className={styles.metaValue}>{detail.voucher_type.name}</span>
              </div>
              {detail.entity_name && (
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>Party</span>
                  <span className={styles.metaValue}>{detail.entity_name}</span>
                </div>
              )}
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Amount</span>
                <span className={`${styles.metaValue} ${styles.metaAmount}`}>
                  {formatIndianCurrency(detail.amount)}
                </span>
              </div>
              {detail.payment_mode && (
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>Mode</span>
                  <span className={styles.metaValue}>{detail.payment_mode.toUpperCase()}</span>
                </div>
              )}
              {detail.bank_ledger_name && (
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>Bank</span>
                  <span className={styles.metaValue}>{detail.bank_ledger_name}</span>
                </div>
              )}
              {detail.utr_number && (
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>UTR</span>
                  <span className={styles.metaValue}>{detail.utr_number}</span>
                </div>
              )}
              {detail.cheque_number && (
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>Cheque</span>
                  <span className={styles.metaValue}>{detail.cheque_number}</span>
                </div>
              )}
              {detail.ref_document_number && (
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>Ref No.</span>
                  <span className={styles.metaValue}>{detail.ref_document_number}</span>
                </div>
              )}
              {detail.narration && (
                <div className={`${styles.metaItem} ${styles.metaFull}`}>
                  <span className={styles.metaLabel}>Narration</span>
                  <span className={styles.metaValue}>{detail.narration}</span>
                </div>
              )}
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Created by</span>
                <span className={styles.metaValue}>{detail.created_by_name}</span>
              </div>
            </div>
          </div>

          {/* ── Entries ─────────────────────────────────────────────── */}
          <div className={styles.panelSection}>
            <div className={styles.sectionHeader}>Accounting Entries</div>
            <EntriesTable entries={detail.entries} />
          </div>

          {/* ── Timeline ────────────────────────────────────────────── */}
          {detail.history.length > 0 && (
            <div className={styles.panelSection}>
              <div className={styles.sectionHeader}>Approval History</div>
              <HistoryTimeline
                submittedAt={detail.created_at}
                submittedBy={detail.created_by_name}
                history={detail.history}
              />
            </div>
          )}

          {/* ── Attachments ─────────────────────────────────────────── */}
          <div className={styles.panelSection}>
            <div className={styles.sectionHeader}>
              Attachments
              {attachments.length > 0 && (
                <span className={styles.attachCount}>{attachments.length}</span>
              )}
            </div>
            {attachments.length === 0 ? (
              <div className={styles.attachEmpty}>No attachments</div>
            ) : (
              <div className={styles.attachGrid}>
                {attachments.map(att => (
                  <a
                    key={att.id}
                    href={att.signed_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.attachItem}
                    title={att.file_name}
                  >
                    {isImage(att.mime_type) ? (
                      <img src={att.signed_url} alt={att.file_name} className={styles.attachThumb} />
                    ) : (
                      <div className={styles.attachFile}>
                        <FileText size={20} />
                        <span>{att.file_name.split('.').pop()?.toUpperCase()}</span>
                      </div>
                    )}
                    <span className={styles.attachName}>{att.file_name}</span>
                    <span className={styles.attachSize}>{formatFileSize(att.file_size)}</span>
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* ── Status-specific actions ──────────────────────────────── */}
          {!isAuditor && row && (
            <div className={`${styles.panelSection} ${styles.actionsSection}`}>

              {/* Draft */}
              {row.status === 'draft' && (
                <>
                  <button
                    className={styles.btnSecondary}
                    onClick={() => navigate(`/vouchers/${row.id}/edit`)}
                  >
                    <Edit3 size={13} /> Edit
                  </button>
                  <button
                    className={styles.btnPrimary}
                    onClick={handleSubmitDraft}
                    disabled={actioning}
                  >
                    {actioning ? <Loader2 size={13} className={styles.spin} /> : <Send size={13} />}
                    Submit for Approval
                  </button>
                  {isAdmin && !confirmDelete && (
                    <button className={styles.btnDanger} onClick={() => setConfirmDelete(true)}>
                      <Trash2 size={13} /> Delete
                    </button>
                  )}
                  {confirmDelete && (
                    <div className={styles.confirmRow}>
                      <span className={styles.confirmText}>Delete this voucher permanently?</span>
                      <button className={styles.btnDanger} onClick={handleDelete} disabled={actioning}>
                        {actioning ? <Loader2 size={12} className={styles.spin} /> : null}
                        Yes, delete
                      </button>
                      <button className={styles.btnSecondary} onClick={() => setConfirmDelete(false)}>
                        Cancel
                      </button>
                    </div>
                  )}
                </>
              )}

              {/* Pending */}
              {row.status === 'pending_approval' && (
                <>
                  <button
                    className={styles.btnSecondary}
                    onClick={() => navigate('/approvals')}
                  >
                    <ExternalLink size={13} /> View in Approval Queue
                  </button>
                  {canRecall && (
                    <button
                      className={styles.btnWarning}
                      onClick={handleRecall}
                      disabled={actioning}
                    >
                      {actioning ? <Loader2 size={13} className={styles.spin} /> : <RotateCcw size={13} />}
                      Recall to Draft
                    </button>
                  )}
                </>
              )}

              {/* Posted */}
              {row.status === 'posted' && (
                <>
                  <button
                    className={`${styles.btnSecondary} ${styles.btnDisabled}`}
                    disabled
                    title="Reversal coming in Phase 3"
                  >
                    <RotateCcw size={13} /> Create Reversal
                    <span className={styles.comingSoon}>Phase 3</span>
                  </button>
                  {detail?.voucher_type?.nature === 'payment' && (
                    detail?.entity_mobile ? (
                      <a
                        href={buildPaymentConfirmedWhatsApp(
                          detail.entity_mobile,
                          detail.entity_name ?? 'there',
                          detail.amount,
                          companyCode,
                          detail.narration,
                        )}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.waBtn}
                        title="Notify payee via WhatsApp"
                      >
                        <MessageCircle size={13} /> Payment Confirmed
                      </a>
                    ) : detail?.entity_id ? (
                      <span className={styles.noMobile}>No mobile on file — cannot send WhatsApp</span>
                    ) : null
                  )}
                </>
              )}

            </div>
          )}

        </div>
      )}
    </aside>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function VoucherRegister() {
  const navigate    = useNavigate()
  const { user }    = useAuth()
  const companyId   = user?.activeCompany?.id   ?? ''
  const companyCode = user?.activeCompany?.code  ?? ''
  const userId      = user?.id                   ?? ''
  const role        = user?.activeRole           ?? null

  // Redirect viewer
  useEffect(() => {
    if (role === 'viewer') navigate('/', { replace: true })
  }, [role, navigate])

  // ── Filters ─────────────────────────────────────────────────────────────
  const [filters,     setFilters]     = useState<RegisterFilters>(defaultFilters)
  const [searchInput, setSearchInput] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setFilter = useCallback(<K extends keyof RegisterFilters>(key: K, val: RegisterFilters[K]) => {
    setFilters(f => ({ ...f, [key]: val }))
  }, [])

  const handleSearchInput = (val: string) => {
    setSearchInput(val)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setFilter('search', val), 400)
  }

  const clearSearch = () => {
    setSearchInput('')
    setFilter('search', '')
  }

  // ── Data ─────────────────────────────────────────────────────────────────
  const [allRows,     setAllRows]     = useState<RegisterVoucher[]>([])
  const [hasMore,     setHasMore]     = useState(false)
  const [page,        setPage]        = useState(0)
  const [loading,     setLoading]     = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const loadPage = useCallback(async (p: number, append: boolean) => {
    if (!companyId) return
    p === 0 ? setLoading(true) : setLoadingMore(true)
    try {
      const { rows, hasMore: more } = await fetchVouchers(companyId, userId, role, filters, p)
      setAllRows(prev => append ? [...prev, ...rows] : rows)
      setHasMore(more)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load vouchers')
    } finally {
      p === 0 ? setLoading(false) : setLoadingMore(false)
    }
  }, [companyId, userId, role, filters])

  useEffect(() => {
    setPage(0)
    setAllRows([])
    loadPage(0, false)
  }, [loadPage])

  const handleLoadMore = () => {
    const next = page + 1
    setPage(next)
    loadPage(next, true)
  }

  const handleRefresh = useCallback(() => {
    setPage(0)
    setAllRows([])
    loadPage(0, false)
  }, [loadPage])

  // ── Panel ─────────────────────────────────────────────────────────────────
  const [selectedId,  setSelectedId]  = useState<string | null>(null)
  const [detail,      setDetail]      = useState<VoucherFull | null>(null)
  const [panelLoading, setPanelLoading] = useState(false)
  const [attachments, setAttachments] = useState<AttachmentWithUrl[]>([])

  const selectedRow = allRows.find(r => r.id === selectedId) ?? null

  const openPanel = (id: string) => {
    if (id === selectedId) { closePanel(); return }
    setSelectedId(id)
    setDetail(null)
    setAttachments([])
    setPanelLoading(true)
    fetchVoucherFull(id)
      .then(setDetail)
      .catch(err => toast.error(err instanceof Error ? err.message : 'Failed to load voucher'))
      .finally(() => setPanelLoading(false))
    fetchVoucherAttachments(id)
      .then(setAttachments)
      .catch(() => {}) // silent — attachments optional
  }

  const closePanel = () => {
    setSelectedId(null)
    setDetail(null)
    setAttachments([])
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.page}>

      {/* Page header */}
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Vouchers</h1>
        <button className={styles.newBtn} onClick={() => navigate('/vouchers/new')}>
          <Plus size={14} /> New Voucher
        </button>
      </div>

      {/* ── Filters bar ─────────────────────────────────────────────────── */}
      <div className={styles.filtersBar}>

        {/* Status pills */}
        <div className={styles.pillGroup}>
          {STATUS_PILLS.map(p => (
            <button
              key={p.value}
              className={`${styles.pill} ${filters.status === p.value ? styles.pillActive : ''}`}
              onClick={() => setFilter('status', p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Nature pills */}
        <div className={styles.pillGroup}>
          {NATURE_PILLS.map(p => {
            const isActive = filters.nature === p.value
            const color    = p.value ? NATURE_COLOR[p.value] : undefined
            return (
              <button
                key={p.value}
                className={`${styles.pill} ${isActive ? styles.pillActive : ''}`}
                style={isActive && color
                  ? { background: `${color}22`, borderColor: `${color}60`, color }
                  : {}}
                onClick={() => setFilter('nature', p.value)}
              >
                {p.label}
              </button>
            )
          })}
        </div>

        {/* Date range */}
        <div className={styles.dateRange}>
          <input
            type="date"
            className={styles.dateInput}
            value={filters.dateFrom}
            onChange={e => setFilter('dateFrom', e.target.value)}
          />
          <span className={styles.dateSep}>—</span>
          <input
            type="date"
            className={styles.dateInput}
            value={filters.dateTo}
            onChange={e => setFilter('dateTo', e.target.value)}
          />
        </div>

        {/* Search */}
        <div className={styles.searchWrap}>
          <Search size={13} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            placeholder="Voucher no. or party name…"
            value={searchInput}
            onChange={e => handleSearchInput(e.target.value)}
          />
          {searchInput && (
            <button className={styles.searchClear} onClick={clearSearch} aria-label="Clear">
              <X size={12} />
            </button>
          )}
        </div>

      </div>

      {/* ── Main: table + slide-over panel ──────────────────────────────── */}
      <div className={`${styles.main} ${selectedId ? styles.mainWithPanel : ''}`}>

        {/* Table area */}
        <div className={styles.tableWrap}>
          {loading ? (
            <div className={styles.centerState}>
              <Loader2 size={24} className={styles.spin} />
            </div>
          ) : allRows.length === 0 ? (
            <div className={styles.emptyState}>
              <BookOpen size={44} className={styles.emptyIcon} />
              <p className={styles.emptyTitle}>No vouchers found</p>
              <p className={styles.emptySub}>
                {filters.status || filters.nature || filters.search
                  ? 'Try adjusting the filters above'
                  : 'Create your first voucher to start recording transactions'}
              </p>
              {!filters.status && !filters.nature && !filters.search && (
                <button className={styles.newBtn} onClick={() => navigate('/vouchers/new')}>
                  <Plus size={14} /> New Voucher
                </button>
              )}
            </div>
          ) : (
            <>
              <table className={styles.table}>
                <thead>
                  <tr className={styles.headerRow}>
                    <th>Voucher No.</th>
                    <th>Type</th>
                    <th>Date</th>
                    <th>Party</th>
                    <th className={styles.right}>Amount</th>
                    <th>Status</th>
                    <th className={styles.hideOnMobile}>Created by</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {allRows.map(v => (
                    <VoucherRow
                      key={v.id}
                      voucher={v}
                      selected={v.id === selectedId}
                      onClick={() => openPanel(v.id)}
                    />
                  ))}
                </tbody>
              </table>

              {hasMore && (
                <div className={styles.loadMoreWrap}>
                  <button
                    className={styles.loadMoreBtn}
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore && <Loader2 size={13} className={styles.spin} />}
                    {loadingMore ? 'Loading…' : 'Load more vouchers'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Slide-over detail panel */}
        <DetailPanel
          row={selectedRow}
          detail={detail}
          loading={panelLoading}
          attachments={attachments}
          companyId={companyId}
          companyCode={companyCode}
          userId={userId}
          role={role}
          onClose={closePanel}
          onRefresh={handleRefresh}
        />

      </div>
    </div>
  )
}
