import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import FoodStreamMini from '@/components/FoodStreamMini'
import {
  Plus, Search, X, ChevronRight, Loader2, CheckCircle, Clock, XCircle,
  AlertCircle, Send, RotateCcw, Copy, Check, Wallet, FileText, Lock, Wrench,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import FoodStreamLoader from '@/components/FoodStreamLoader'
import {
  fetchSuspenseVouchers, fetchSuspenseSession, fetchSuspenseSettlements,
  createOrRefreshSession, buildSettlementUrl,
  approveSuspenseVoucher, rejectSuspenseVoucher,
  approveSettlement, rejectSettlement,
  addTopUp, submitExpenseEntry, closeVoucher, fixBalance,
  suspenseStatusLabel, settlementStatusLabel,
  type SuspenseVoucher, type SuspenseSession, type SuspenseSettlement,
} from '@/lib/suspense'
import { formatIndianCurrency } from '@/lib/vouchers'
import { fetchVoucherAttachments, isImage, formatFileSize, type AttachmentWithUrl } from '@/lib/attachments'
import styles from './SuspenseRegister.module.css'

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

// ── WhatsApp URL builder ─────────────────────────────────────────────────────

function buildWhatsAppUrl(
  mobile: string,
  name: string,
  amount: number,
  purpose: string | null,
  settlementUrl: string,
  companyCode: string,
): string {
  const digits = mobile.replace(/\D/g, '') // strip + and any non-digits
  const amtStr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount)
  const purposeStr = purpose ?? 'company expenses'
  const msg =
    `\u{1F9FE} *Relish Accounts \u2014 Advance Settlement*\n\n` +
    `Hi ${name},\n\n` +
    `You have a pending advance of *${amtStr}* from ${companyCode} for ${purposeStr}.\n\n` +
    `Please submit your expenses using the link below:\n\n` +
    `\uD83D\uDC49 ${settlementUrl}\n\n` +
    `\u2014 Relish Accounts`
  return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`
}

// ── Status Badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'pending_approval':
      return (
        <span className={`${styles.badge} ${styles.badgePending}`}>
          <span className={styles.pulseDot} /> Pending
        </span>
      )
    case 'open':
      return <span className={`${styles.badge} ${styles.badgeOpen}`}>Open</span>
    case 'partial':
      return <span className={`${styles.badge} ${styles.badgePartial}`}>Partial</span>
    case 'closed':
      return <span className={`${styles.badge} ${styles.badgeClosed}`}>Closed</span>
    case 'rejected':
      return <span className={`${styles.badge} ${styles.badgeRejected}`}>Rejected</span>
    default:
      return <span className={`${styles.badge} ${styles.badgePending}`}>{status}</span>
  }
}

// ── Stats Grid ────────────────────────────────────────────────────────────────

function StatsGrid({ row, settlements }: { row: SuspenseVoucher; settlements: SuspenseSettlement[] }) {
  const topupsTotal = settlements
    .filter(s => s.entry_type === 'topup' && s.status === 'approved')
    .reduce((acc, s) => acc + (s.advance_amount ?? 0), 0)
  const initialAmount = Math.max(0, row.amount - topupsTotal)

  const approvedExpenses = settlements
    .filter(s => s.entry_type === 'expense' && s.status === 'approved')
    .reduce((acc, s) => acc + (s.settled_amount ?? 0), 0)
  const pendingExpenses = settlements
    .filter(s => s.entry_type === 'expense' && s.status === 'pending')
    .reduce((acc, s) => acc + (s.settled_amount ?? 0), 0)

  const balance = row.suspense_balance ?? row.amount
  const pct     = row.amount > 0 ? Math.min(100, ((row.amount - balance) / row.amount) * 100) : 0

  return (
    <div className={styles.statsGrid}>
      <div className={styles.statCard}>
        <span className={styles.statLabel}>Advance Issued</span>
        <span className={styles.statValue}>{formatIndianCurrency(row.amount)}</span>
        {topupsTotal > 0 && (
          <span className={styles.statBreakdown}>
            Initial {formatIndianCurrency(initialAmount)} + Top-ups {formatIndianCurrency(topupsTotal)}
          </span>
        )}
      </div>
      <div className={`${styles.statCard} ${styles.statCardApproved}`}>
        <span className={styles.statLabel}>Expenses Approved</span>
        <span className={`${styles.statValue} ${styles.statValueApproved}`}>
          {formatIndianCurrency(approvedExpenses)}
        </span>
      </div>
      <div className={`${styles.statCard} ${styles.statCardPending}`}>
        <span className={styles.statLabel}>Expenses Pending</span>
        <span className={`${styles.statValue} ${styles.statValuePending}`}>
          {formatIndianCurrency(pendingExpenses)}
        </span>
        {pendingExpenses > 0 && <span className={styles.statSubNote}>awaiting review</span>}
      </div>
      <div className={`${styles.statCard} ${styles.statCardBalance}`}>
        <span className={styles.statLabel}>Remaining Balance</span>
        <span className={`${styles.statValue} ${balance === 0 ? styles.statValueZero : styles.statValueBalance}`}>
          {formatIndianCurrency(balance)}
        </span>
      </div>
      <div className={styles.statsProgressWrap}>
        <div className={styles.statsProgressFill} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// ── Settlements Table ─────────────────────────────────────────────────────────

function SettlementsTable({
  settlements, onApprove, onReject, role, loading,
}: {
  settlements:  SuspenseSettlement[]
  onApprove:    (id: string) => void
  onReject:     (id: string) => void
  role:         string | null
  loading:      boolean
}) {
  const canAct = role === 'admin' || role === 'accounts'

  if (loading) return <FoodStreamLoader label="Loading suspense" />
  if (settlements.length === 0) return <div className={styles.emptySettlements}>No expenses submitted yet</div>

  return (
    <div className={styles.settlementsWrap}>
      <table className={styles.settlementsTable}>
        <thead>
          <tr>
            <th>Description</th>
            <th>Type</th>
            <th>Date</th>
            <th>By</th>
            <th className={styles.right}>Amount</th>
            <th>Status</th>
            {canAct && <th />}
          </tr>
        </thead>
        <tbody>
          {settlements.map(s => (
            <tr key={s.id} className={styles.settlementRow}>
              <td>
                <div className={styles.settlementDesc}>{s.description ?? '—'}</div>
                {s.head_of_account && <div className={styles.settlementSub}>{s.head_of_account}</div>}
                {s.reference_number && <div className={styles.settlementSub}>Ref: {s.reference_number}</div>}
              </td>
              <td>
                <span className={`${styles.entryTypeBadge} ${styles[`type_${s.entry_type}`]}`}>
                  {s.entry_type}
                </span>
              </td>
              <td className={styles.settlementDate}>{fmtDateTime(s.created_at)}</td>
              <td className={styles.settlementBy}>
                {s.submitted_by_name
                  ? s.submitted_by_name
                  : s.settlement_session_id
                    ? 'Staff (link)'
                    : 'Accounts'}
              </td>
              <td className={`${styles.right} ${styles.settlementAmt}`}>
                {formatIndianCurrency(s.settled_amount ?? 0)}
              </td>
              <td>
                <span className={`${styles.settlementStatus} ${styles[`ss_${s.status}`]}`}>
                  {settlementStatusLabel(s.status)}
                </span>
              </td>
              {canAct && s.status === 'pending' && (
                <td className={styles.settlementActions}>
                  <button
                    className={styles.btnApproveSmall}
                    title="Approve entry"
                    onClick={() => onApprove(s.id)}
                  >
                    <CheckCircle size={13} />
                  </button>
                  <button
                    className={styles.btnRejectSmall}
                    title="Reject entry"
                    onClick={() => onReject(s.id)}
                  >
                    <XCircle size={13} />
                  </button>
                </td>
              )}
              {canAct && s.status !== 'pending' && <td />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Detail Panel ──────────────────────────────────────────────────────────────

interface PanelProps {
  row:         SuspenseVoucher | null
  session:     SuspenseSession | null
  settlements: SuspenseSettlement[]
  attachments: AttachmentWithUrl[]
  loading:     boolean
  companyId:   string
  companyCode: string
  userId:      string
  role:        string | null
  onClose:     () => void
  onRefresh:   () => void
}

function DetailPanel({
  row, session, settlements, attachments, loading,
  companyId, companyCode, userId, role, onClose, onRefresh,
}: PanelProps) {
  const [actioning,      setActioning]      = useState(false)
  const [rejectReason,   setRejectReason]   = useState('')
  const [showReject,     setShowReject]      = useState(false)
  const [rejectEntryId,  setRejectEntryId]  = useState<string | null>(null)
  const [rejectEntryReason, setRejectEntryReason] = useState('')
  const [copiedLink,     setCopiedLink]     = useState(false)
  const [settlementUrl,  setSettlementUrl]  = useState<string | null>(null)
  const [showAddEntry,   setShowAddEntry]   = useState(false)
  const [showTopUp,      setShowTopUp]      = useState(false)
  const [settlementsLoading, setSettlementsLoading] = useState(false)

  // Add settlement inline form state
  const [entryType,     setEntryType]     = useState<'expense'|'refund'>('expense')
  const [entryAmount,   setEntryAmount]   = useState('')
  const [entryDesc,     setEntryDesc]     = useState('')
  const [entryHoA,      setEntryHoA]      = useState('')
  const [entryRef,      setEntryRef]      = useState('')
  const [entryInvoice,  setEntryInvoice]  = useState(true)
  const [entrySubmitting, setEntrySubmitting] = useState(false)

  // Top-up inline form state
  const [topUpAmount,   setTopUpAmount]   = useState('')
  const [topUpDesc,     setTopUpDesc]     = useState('')
  const [topUpSubmitting, setTopUpSubmitting] = useState(false)
  const [showClose,     setShowClose]     = useState(false)

  // Reset panel state when row changes
  useEffect(() => {
    setShowReject(false)
    setRejectReason('')
    setRejectEntryId(null)
    setShowAddEntry(false)
    setShowTopUp(false)
    setShowClose(false)
    setSettlementUrl(session ? buildSettlementUrl(session.token) : null)
  }, [row?.id, session])

  const isAdmin   = role === 'admin' || role === 'super_admin'
  const isAuditor = role === 'auditor'

  // ── Admin approve advance
  const handleApproveAdvance = async () => {
    if (!row) return
    setActioning(true)
    try {
      await approveSuspenseVoucher(row.id, companyId, companyCode, 'SUS', userId, row.voucher_date)
      toast.success('Advance approved — staff link can now be sent')
      onRefresh(); onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to approve')
    } finally { setActioning(false) }
  }

  // ── Admin reject advance
  const handleRejectAdvance = async () => {
    if (!row || !rejectReason.trim()) return
    setActioning(true)
    try {
      await rejectSuspenseVoucher(row.id, userId, rejectReason.trim())
      toast.success('Advance rejected')
      onRefresh(); onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to reject')
    } finally { setActioning(false) }
  }

  // ── Send settlement link
  const handleSendLink = async () => {
    if (!row) return
    setActioning(true)
    try {
      const sess = await createOrRefreshSession(
        companyId, row.entity_id ?? '', userId, row.id, row.amount,
      )
      const url = buildSettlementUrl(sess.token)
      setSettlementUrl(url)
      if (!row.entity_mobile) toast.info('No mobile on file — copy the link and share manually')
      else toast.success('Settlement link ready — send via WhatsApp below')
      onRefresh()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create link')
    } finally { setActioning(false) }
  }

  // ── Copy link
  const handleCopyLink = () => {
    if (!settlementUrl) return
    navigator.clipboard.writeText(settlementUrl).then(() => {
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 2000)
    })
  }

  // ── Approve settlement entry
  const handleApproveEntry = async (settlementId: string) => {
    setSettlementsLoading(true)
    try {
      await approveSettlement(settlementId, userId)
      toast.success('Entry approved')
      onRefresh()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to approve entry')
    } finally { setSettlementsLoading(false) }
  }

  // ── Reject settlement entry
  const handleRejectEntry = (settlementId: string) => {
    setRejectEntryId(settlementId)
    setRejectEntryReason('')
  }

  const confirmRejectEntry = async () => {
    if (!rejectEntryId || !rejectEntryReason.trim()) return
    setSettlementsLoading(true)
    try {
      await rejectSettlement(rejectEntryId, userId, rejectEntryReason.trim())
      toast.success('Entry rejected')
      setRejectEntryId(null)
      onRefresh()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to reject entry')
    } finally { setSettlementsLoading(false) }
  }

  // ── Add direct entry (accounts)
  const handleAddEntry = async () => {
    if (!row || !entryDesc.trim() || !parseFloat(entryAmount)) return
    setEntrySubmitting(true)
    try {
      await submitExpenseEntry({
        advance_voucher_id: row.id,
        session_id:         session?.id ?? null,
        company_id:         companyId,
        entity_id:          row.entity_id,
        amount:             parseFloat(entryAmount),
        entry_type:         entryType,
        description:        entryDesc.trim(),
        head_of_account:    entryHoA.trim() || null,
        reference_number:   entryRef.trim() || null,
        invoice_available:  entryInvoice,
        attachment_path:    null,
        submitted_by:       userId,
      })
      toast.success('Settlement entry added')
      setShowAddEntry(false)
      setEntryAmount(''); setEntryDesc(''); setEntryHoA(''); setEntryRef('')
      onRefresh()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to add entry')
    } finally { setEntrySubmitting(false) }
  }

  // ── Close voucher
  const handleCloseVoucher = async () => {
    if (!row) return
    setActioning(true)
    try {
      await closeVoucher(row.id, userId)
      toast.success('Voucher closed')
      setShowClose(false)
      onRefresh(); onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to close voucher')
    } finally { setActioning(false) }
  }

  // ── Fix balance
  const handleFixBalance = async () => {
    if (!row) return
    setActioning(true)
    try {
      await fixBalance(row.id)
      toast.success('Balance recalculated from approved entries')
      onRefresh()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to fix balance')
    } finally { setActioning(false) }
  }

  // ── Top-up
  const handleTopUp = async () => {
    if (!row || !parseFloat(topUpAmount) || !topUpDesc.trim()) return
    setTopUpSubmitting(true)
    try {
      await addTopUp(row.id, companyId, row.entity_id, parseFloat(topUpAmount), topUpDesc.trim(), userId)
      toast.success('Top-up added — balance increased')
      setShowTopUp(false)
      setTopUpAmount(''); setTopUpDesc('')
      onRefresh()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to add top-up')
    } finally { setTopUpSubmitting(false) }
  }

  // ── Derived stats for header + grid
  const topupsTotal  = settlements
    .filter(s => s.entry_type === 'topup' && s.status === 'approved')
    .reduce((acc, s) => acc + (s.advance_amount ?? 0), 0)
  const initialAmount = Math.max(0, (row?.amount ?? 0) - topupsTotal)

  return (
    <aside className={`${styles.panel} ${row ? styles.panelOpen : ''}`}>
      {/* Header */}
      <div className={styles.panelHeader}>
        <div className={styles.panelHeaderMeta}>
          <div className={styles.panelHeaderLeft}>
            <span className={styles.panelVoucherNo}>{row?.voucher_number ?? '—'}</span>
            {row && <StatusBadge status={row.status} />}
          </div>
          {topupsTotal > 0 && (
            <span className={styles.panelTopupSub}>
              Initial {formatIndianCurrency(initialAmount)} + Top-ups {formatIndianCurrency(topupsTotal)}
            </span>
          )}
        </div>
        <button className={styles.panelClose} onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      {loading ? (
        <div className={styles.panelLoading}><FoodStreamMini size={50} label="" /></div>
      ) : !row ? null : (
        <div className={styles.panelBody}>

          {/* ── Primary Actions ──────────────────────────────────────── */}
          {!isAuditor && (
            <div className={`${styles.panelSection} ${styles.actionsSection}`}>

              {/* pending_approval — admin approve/reject */}
              {row.status === 'pending_approval' && isAdmin && (
                <>
                  <button className={styles.btnPrimary} onClick={handleApproveAdvance} disabled={actioning}>
                    {actioning ? <Loader2 size={13} className={styles.spin} /> : <CheckCircle size={13} />}
                    Approve Advance
                  </button>
                  {!showReject ? (
                    <button className={styles.btnDanger} onClick={() => setShowReject(true)}>
                      <XCircle size={13} /> Reject
                    </button>
                  ) : (
                    <div className={styles.rejectBox}>
                      <span className={styles.rejectLabel}>Reason for rejection</span>
                      <input
                        className={styles.rejectInput}
                        placeholder="Required"
                        value={rejectReason}
                        onChange={e => setRejectReason(e.target.value)}
                        autoFocus
                      />
                      <div className={styles.rejectBtns}>
                        <button className={styles.btnDanger} onClick={handleRejectAdvance} disabled={!rejectReason.trim() || actioning}>
                          Confirm Reject
                        </button>
                        <button className={styles.btnSecondary} onClick={() => setShowReject(false)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* pending_approval — accounts user (read-only) */}
              {row.status === 'pending_approval' && !isAdmin && (
                <div className={styles.waitingNote}>
                  <Clock size={14} />
                  Waiting for admin approval
                </div>
              )}

              {/* open / partial */}
              {(row.status === 'open' || row.status === 'partial') && (
                <>
                  <button
                    className={styles.btnSecondary}
                    onClick={() => { setShowAddEntry(!showAddEntry); setShowTopUp(false); setShowClose(false) }}
                  >
                    <Plus size={13} /> Add Settlement Entry
                  </button>
                  <button
                    className={styles.btnSecondary}
                    onClick={() => { setShowTopUp(!showTopUp); setShowAddEntry(false); setShowClose(false) }}
                  >
                    <RotateCcw size={13} /> Top Up
                  </button>
                  <button
                    className={styles.btnWarning}
                    onClick={() => { setShowClose(!showClose); setShowAddEntry(false); setShowTopUp(false) }}
                  >
                    <Lock size={13} /> Close Voucher
                  </button>
                  {isAdmin && (
                    <button
                      className={styles.btnGhost}
                      onClick={handleFixBalance}
                      disabled={actioning}
                      title="Recalculate balance from approved entries"
                    >
                      <Wrench size={13} /> Fix Balance
                    </button>
                  )}

                  {/* Add entry inline form */}
                  {showAddEntry && (
                    <div className={styles.inlineForm}>
                      <div className={styles.inlineRow}>
                        <button
                          className={`${styles.typePill} ${entryType === 'expense' ? styles.typePillActive : ''}`}
                          onClick={() => setEntryType('expense')}
                        ><Wallet size={11} /> Expense</button>
                        <button
                          className={`${styles.typePill} ${entryType === 'refund' ? styles.typePillActive : ''}`}
                          onClick={() => setEntryType('refund')}
                        ><RotateCcw size={11} /> Refund</button>
                      </div>
                      <input className={styles.inlineInput} placeholder="Description *" value={entryDesc} onChange={e => setEntryDesc(e.target.value)} />
                      <div className={styles.inlineRow}>
                        <div className={styles.amountSmallWrap}>
                          <span className={styles.rupeeSmall}>₹</span>
                          <input
                            type="number" className={styles.inlineAmountInput}
                            placeholder="Amount *" value={entryAmount}
                            onChange={e => setEntryAmount(e.target.value)} min={0}
                          />
                        </div>
                        <input className={`${styles.inlineInput} ${styles.flex1}`} placeholder="Head of Account" value={entryHoA} onChange={e => setEntryHoA(e.target.value)} />
                      </div>
                      <div className={styles.inlineRow}>
                        <input className={`${styles.inlineInput} ${styles.flex1}`} placeholder="Reference / Receipt No." value={entryRef} onChange={e => setEntryRef(e.target.value)} />
                        <label className={styles.invoiceToggle}>
                          <input type="checkbox" checked={entryInvoice} onChange={e => setEntryInvoice(e.target.checked)} />
                          Invoice available
                        </label>
                      </div>
                      <button
                        className={styles.btnPrimary}
                        onClick={handleAddEntry}
                        disabled={entrySubmitting || !entryDesc.trim() || !parseFloat(entryAmount)}
                      >
                        {entrySubmitting ? <Loader2 size={13} className={styles.spin} /> : null}
                        Add Entry
                      </button>
                    </div>
                  )}

                  {/* Top-up inline form */}
                  {showTopUp && (
                    <div className={styles.inlineForm}>
                      <div className={styles.amountSmallWrap}>
                        <span className={styles.rupeeSmall}>₹</span>
                        <input
                          type="number" className={styles.inlineAmountInput}
                          placeholder="Top-up amount *" value={topUpAmount}
                          onChange={e => setTopUpAmount(e.target.value)} min={0}
                        />
                      </div>
                      <input className={styles.inlineInput} placeholder="Description / reason *" value={topUpDesc} onChange={e => setTopUpDesc(e.target.value)} />
                      <button
                        className={styles.btnPrimary}
                        onClick={handleTopUp}
                        disabled={topUpSubmitting || !parseFloat(topUpAmount) || !topUpDesc.trim()}
                      >
                        {topUpSubmitting ? <Loader2 size={13} className={styles.spin} /> : null}
                        Add Top-Up
                      </button>
                    </div>
                  )}

                  {/* Close voucher confirmation */}
                  {showClose && (
                    <div className={styles.closeConfirm}>
                      <span className={styles.closeConfirmMsg}>
                        Mark this advance as closed? Settlements will be locked unless reopened via top-up.
                      </span>
                      <div className={styles.rejectBtns}>
                        <button className={styles.btnWarning} onClick={handleCloseVoucher} disabled={actioning}>
                          {actioning ? <Loader2 size={13} className={styles.spin} /> : <Lock size={13} />}
                          Confirm Close
                        </button>
                        <button className={styles.btnSecondary} onClick={() => setShowClose(false)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* closed — top-up only */}
              {row.status === 'closed' && (
                <>
                  <button
                    className={styles.btnSecondary}
                    onClick={() => { setShowTopUp(!showTopUp) }}
                  >
                    <RotateCcw size={13} /> Top Up (reopen)
                  </button>
                  {showTopUp && (
                    <div className={styles.inlineForm}>
                      <div className={styles.amountSmallWrap}>
                        <span className={styles.rupeeSmall}>₹</span>
                        <input
                          type="number" className={styles.inlineAmountInput}
                          placeholder="Top-up amount *" value={topUpAmount}
                          onChange={e => setTopUpAmount(e.target.value)} min={0}
                        />
                      </div>
                      <input className={styles.inlineInput} placeholder="Description / reason *" value={topUpDesc} onChange={e => setTopUpDesc(e.target.value)} />
                      <button
                        className={styles.btnPrimary}
                        onClick={handleTopUp}
                        disabled={topUpSubmitting || !parseFloat(topUpAmount) || !topUpDesc.trim()}
                      >
                        {topUpSubmitting ? <Loader2 size={13} className={styles.spin} /> : null}
                        Add Top-Up
                      </button>
                    </div>
                  )}
                </>
              )}

            </div>
          )}

          {/* ── Stats Grid ────────────────────────────────────────────── */}
          {row.status !== 'pending_approval' && row.status !== 'rejected' && (
            <div className={styles.panelSection}>
              <StatsGrid row={row} settlements={settlements} />
            </div>
          )}
          <div className={styles.panelSection}>
            <div className={styles.metaGrid}>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Date</span>
                <span className={styles.metaValue}>{fmtDate(row.voucher_date)}</span>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Status</span>
                <span className={styles.metaValue}>{suspenseStatusLabel(row.status)}</span>
              </div>
              {row.entity_name && (
                <div className={`${styles.metaItem} ${styles.metaFull}`}>
                  <span className={styles.metaLabel}>Staff Payee</span>
                  <span className={styles.metaValue}>{row.entity_name}</span>
                </div>
              )}
              {row.suspense_purpose && (
                <div className={`${styles.metaItem} ${styles.metaFull}`}>
                  <span className={styles.metaLabel}>Purpose</span>
                  <span className={styles.metaValue}>{row.suspense_purpose}</span>
                </div>
              )}
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Created by</span>
                <span className={styles.metaValue}>{row.created_by_name}</span>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Created</span>
                <span className={styles.metaValue}>{fmtDateTime(row.created_at)}</span>
              </div>
            </div>
          </div>

          {/* ── Settlement link ───────────────────────────────────────── */}
          {!isAuditor && (row.status === 'open' || row.status === 'partial') && (
            <div className={styles.panelSection}>
              <div className={styles.sectionHeader}>Settlement Link</div>
              {settlementUrl ? (
                <div className={styles.linkBox}>
                  <span className={styles.linkUrl}>{settlementUrl}</span>
                  <button className={styles.copyBtn} onClick={handleCopyLink} title="Copy link">
                    {copiedLink ? <Check size={14} /> : <Copy size={14} />}
                    {copiedLink ? 'Copied!' : 'Copy'}
                  </button>
                  {row.entity_mobile ? (
                    <a
                      href={buildWhatsAppUrl(
                        row.entity_mobile,
                        row.entity_name ?? 'there',
                        row.amount,
                        row.suspense_purpose,
                        settlementUrl,
                        companyCode,
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.waBtn}
                      title="Send via WhatsApp"
                    >
                      WhatsApp
                    </a>
                  ) : (
                    <span className={styles.noMobile}>No mobile on file</span>
                  )}
                </div>
              ) : (
                <button className={styles.btnPrimary} onClick={handleSendLink} disabled={actioning}>
                  {actioning ? <Loader2 size={13} className={styles.spin} /> : <Send size={13} />}
                  Generate Settlement Link
                </button>
              )}
              <p className={styles.smsNote}>
                Copy the link or tap WhatsApp to send directly to the staff member.
              </p>
            </div>
          )}

          {/* ── Settlement entries ────────────────────────────────────── */}
          {row.status !== 'pending_approval' && row.status !== 'rejected' && (
            <div className={styles.panelSection}>
              <div className={styles.sectionHeader}>
                Settlement Entries
                {settlements.filter(s => s.status === 'pending').length > 0 && (
                  <span className={styles.pendingCount}>
                    {settlements.filter(s => s.status === 'pending').length} pending review
                  </span>
                )}
              </div>

              <SettlementsTable
                settlements={settlements}
                onApprove={handleApproveEntry}
                onReject={handleRejectEntry}
                role={role}
                loading={settlementsLoading}
              />

              {/* Reject entry with reason */}
              {rejectEntryId && (
                <div className={styles.rejectBox}>
                  <span className={styles.rejectLabel}>Reason for rejection</span>
                  <input
                    className={styles.rejectInput}
                    placeholder="Required"
                    value={rejectEntryReason}
                    onChange={e => setRejectEntryReason(e.target.value)}
                    autoFocus
                  />
                  <div className={styles.rejectBtns}>
                    <button
                      className={styles.btnDanger}
                      onClick={confirmRejectEntry}
                      disabled={!rejectEntryReason.trim()}
                    >Reject Entry</button>
                    <button className={styles.btnSecondary} onClick={() => setRejectEntryId(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Attachments ───────────────────────────────────────────── */}
          {attachments.length > 0 && (
            <div className={styles.panelSection}>
              <div className={styles.sectionHeader}>
                Attachments
                <span className={styles.attachCount}>{attachments.length}</span>
              </div>
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
                    {isImage(att.mime_type)
                      ? <img src={att.signed_url} alt={att.file_name} className={styles.attachThumb} />
                      : (
                        <div className={styles.attachFile}>
                          <FileText size={20} />
                          <span>{att.file_name.split('.').pop()?.toUpperCase()}</span>
                        </div>
                      )
                    }
                    <span className={styles.attachName}>{att.file_name}</span>
                    <span className={styles.attachSize}>{formatFileSize(att.file_size)}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

        </div>
      )}
    </aside>
  )
}

// ── Register page ─────────────────────────────────────────────────────────────

const STATUS_PILLS = [
  { label: 'All',       value: '' },
  { label: 'Pending',   value: 'pending_approval' },
  { label: 'Open',      value: 'open' },
  { label: 'Partial',   value: 'partial' },
  { label: 'Closed',    value: 'closed' },
  { label: 'Rejected',  value: 'rejected' },
]

function defaultFrom() {
  const d = new Date(); d.setMonth(d.getMonth() - 3)
  return d.toISOString().slice(0, 10)
}

export default function SuspenseRegister() {
  const navigate    = useNavigate()
  const { user }    = useAuth()
  const companyId   = user?.activeCompany?.id  ?? ''
  const companyCode = user?.activeCompany?.code ?? ''
  const userId      = user?.id                  ?? ''
  const role        = user?.activeRole          ?? null

  useEffect(() => {
    if (role === 'viewer') navigate('/', { replace: true })
  }, [role, navigate])

  // ── Filters ────────────────────────────────────────────────────────────────
  const [statusFilter, setStatusFilter] = useState('')
  const [dateFrom,     setDateFrom]     = useState(defaultFrom)
  const [dateTo,       setDateTo]       = useState(() => new Date().toISOString().slice(0, 10))
  const [searchInput,  setSearchInput]  = useState('')
  const [searchQuery,  setSearchQuery]  = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSearchInput = (val: string) => {
    setSearchInput(val)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setSearchQuery(val), 400)
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  const [allRows,     setAllRows]     = useState<SuspenseVoucher[]>([])
  const [hasMore,     setHasMore]     = useState(false)
  const [page,        setPage]        = useState(0)
  const [loading,     setLoading]     = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  const loadPage = useCallback(async (p: number, append: boolean) => {
    if (!companyId) return
    p === 0 ? setLoading(true) : setLoadingMore(true)
    try {
      const { rows, hasMore: more } = await fetchSuspenseVouchers(companyId, userId, role, p)
      // Client-side filter (status, date range, search) — fetchSuspenseVouchers already
      // handles role-based visibility; we filter the rest here to avoid extra query params
      const filtered = rows.filter(r => {
        if (statusFilter && r.status !== statusFilter) return false
        if (r.voucher_date < dateFrom || r.voucher_date > dateTo) return false
        if (searchQuery) {
          const q = searchQuery.toLowerCase()
          if (
            !r.voucher_number.toLowerCase().includes(q) &&
            !(r.entity_name ?? '').toLowerCase().includes(q) &&
            !(r.suspense_purpose ?? '').toLowerCase().includes(q)
          ) return false
        }
        return true
      })
      setAllRows(prev => append ? [...prev, ...filtered] : filtered)
      setHasMore(more)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      p === 0 ? setLoading(false) : setLoadingMore(false)
    }
  }, [companyId, userId, role, statusFilter, dateFrom, dateTo, searchQuery])

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

  // ── Panel ──────────────────────────────────────────────────────────────────
  const [selectedId,   setSelectedId]   = useState<string | null>(null)
  const [panelLoading, setPanelLoading] = useState(false)
  const [panelSession, setPanelSession] = useState<SuspenseSession | null>(null)
  const [settlements,  setSettlements]  = useState<SuspenseSettlement[]>([])
  const [attachments,  setAttachments]  = useState<AttachmentWithUrl[]>([])

  const selectedRow = allRows.find(r => r.id === selectedId) ?? null

  const openPanel = (id: string) => {
    if (id === selectedId) { closePanel(); return }
    setSelectedId(id)
    setPanelSession(null)
    setSettlements([])
    setAttachments([])
    setPanelLoading(true)
    Promise.all([
      fetchSuspenseSession(id),
      fetchSuspenseSettlements(id),
      fetchVoucherAttachments(id),
    ]).then(([sess, setts, atts]) => {
      setPanelSession(sess)
      setSettlements(setts)
      setAttachments(atts)
    }).catch(err => toast.error(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setPanelLoading(false))
  }

  const closePanel = () => {
    setSelectedId(null)
    setPanelSession(null)
    setSettlements([])
    setAttachments([])
  }

  // Refresh panel data after an action
  const refreshPanel = useCallback(() => {
    handleRefresh()
    if (selectedId) {
      Promise.all([
        fetchSuspenseSession(selectedId),
        fetchSuspenseSettlements(selectedId),
        fetchVoucherAttachments(selectedId),
      ]).then(([sess, setts, atts]) => {
        setPanelSession(sess)
        setSettlements(setts)
        setAttachments(atts)
      }).catch(() => {})
    }
  }, [handleRefresh, selectedId])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={styles.page}>

      {/* Page header */}
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Suspense Advances</h1>
        {(role === 'admin' || role === 'accounts') && (
          <button className={styles.newBtn} onClick={() => navigate('/suspense/new')}>
            <Plus size={14} /> New Advance
          </button>
        )}
      </div>

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className={styles.filtersBar}>
        <div className={styles.pillGroup}>
          {STATUS_PILLS.map(p => (
            <button
              key={p.value}
              className={`${styles.pill} ${statusFilter === p.value ? styles.pillActive : ''}`}
              onClick={() => setStatusFilter(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className={styles.dateRange}>
          <input type="date" className={styles.dateInput} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          <span className={styles.dateSep}>—</span>
          <input type="date" className={styles.dateInput} value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>

        <div className={styles.searchWrap}>
          <Search size={13} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            placeholder="Voucher no., payee or purpose…"
            value={searchInput}
            onChange={e => handleSearchInput(e.target.value)}
          />
          {searchInput && (
            <button className={styles.searchClear} onClick={() => { setSearchInput(''); setSearchQuery('') }}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* ── Main ─────────────────────────────────────────────────────────── */}
      <div className={`${styles.main} ${selectedId ? styles.mainWithPanel : ''}`}>

        <div className={styles.tableWrap}>
          {loading ? (
            <div className={styles.centerState}><FoodStreamMini label="" /></div>
          ) : allRows.length === 0 ? (
            <div className={styles.emptyState}>
              <Wallet size={44} className={styles.emptyIcon} />
              <p className={styles.emptyTitle}>No suspense advances found</p>
              <p className={styles.emptySub}>
                {statusFilter || searchInput
                  ? 'Try adjusting the filters'
                  : 'Create the first suspense advance to track staff expenses'}
              </p>
              {!statusFilter && !searchInput && (role === 'admin' || role === 'accounts') && (
                <button className={styles.newBtn} onClick={() => navigate('/suspense/new')}>
                  <Plus size={14} /> New Advance
                </button>
              )}
            </div>
          ) : (
            <>
              <table className={styles.table}>
                <thead>
                  <tr className={styles.headerRow}>
                    <th>Voucher No.</th>
                    <th>Payee</th>
                    <th>Purpose</th>
                    <th className={styles.right}>Advance</th>
                    <th className={styles.right}>Balance</th>
                    <th>Status</th>
                    <th className={styles.hideOnMobile}>Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {allRows.map(v => (
                    <tr
                      key={v.id}
                      className={`${styles.row} ${v.id === selectedId ? styles.rowSelected : ''}`}
                      onClick={() => openPanel(v.id)}
                    >
                      <td className={styles.voucherNo}>{v.voucher_number}</td>
                      <td className={styles.partyCell}>{v.entity_name ?? <span className={styles.dim}>—</span>}</td>
                      <td className={styles.purposeCell}>{v.suspense_purpose ?? <span className={styles.dim}>—</span>}</td>
                      <td className={`${styles.right} ${styles.amountCell}`}>
                        {formatIndianCurrency(v.amount)}
                      </td>
                      <td className={`${styles.right} ${styles.amountCell}`}>
                        {v.status === 'pending_approval' || v.status === 'rejected'
                          ? <span className={styles.dim}>—</span>
                          : <span className={v.suspense_balance === 0 ? styles.zeroBalance : ''}>
                              {formatIndianCurrency(v.suspense_balance ?? v.amount)}
                            </span>
                        }
                      </td>
                      <td><StatusBadge status={v.status} /></td>
                      <td className={`${styles.dim} ${styles.hideOnMobile}`}>{fmtDate(v.voucher_date)}</td>
                      <td>
                        <ChevronRight
                          size={14}
                          className={`${styles.chevron} ${v.id === selectedId ? styles.chevronActive : ''}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {hasMore && (
                <div className={styles.loadMoreWrap}>
                  <button className={styles.loadMoreBtn} onClick={handleLoadMore} disabled={loadingMore}>
                    {loadingMore && <Loader2 size={13} className={styles.spin} />}
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <DetailPanel
          row={selectedRow}
          session={panelSession}
          settlements={settlements}
          attachments={attachments}
          loading={panelLoading}
          companyId={companyId}
          companyCode={companyCode}
          userId={userId}
          role={role}
          onClose={closePanel}
          onRefresh={refreshPanel}
        />
      </div>
    </div>
  )
}
