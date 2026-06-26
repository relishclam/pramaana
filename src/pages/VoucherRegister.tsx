import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus, Search, X, ChevronRight, Loader2, CheckCircle, Clock, XCircle,
  AlertCircle, FileText, ExternalLink, Trash2, Edit3, Send, RotateCcw, BookOpen,
  Download, ChevronDown, Paperclip,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchVoucherFull,
  type VoucherFull,
  type VoucherEntryDetail,
  type ApprovalHistoryItem,
} from '@/lib/approvals'
import { exportVouchersCsv, type VoucherRecord } from '@/lib/exportVoucherCsv'
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
  uploadVoucherAttachments,
} from '@/lib/attachments'
import { initiatePaymentOtp, verifyPaymentOtp } from '@/lib/otp'
import { sendPaymentConfirmedSms } from '@/lib/sms'
import { formatIndianCurrency } from '@/lib/vouchers'
import styles from './VoucherRegister.module.css'

// ── Constants ─────────────────────────────────────────────────────────────────

const menuItem: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left',
  padding: '0.625rem 1rem', fontSize: '0.8125rem',
  border: 'none', background: 'none', cursor: 'pointer',
  color: '#333', fontFamily: 'inherit',
}

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

const OTP_LENGTH = 6
const OTP_RESEND_COOLDOWN_SECONDS = 60

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── WhatsApp payment confirmation URL builder ────────────────────────────────
function buildWhatsAppPaymentUrl(
  mobile: string,
  name: string,
  amount: number,
  voucherNo: string,
  companyCode: string,
): string {
  const digits = mobile.replace(/\D/g, '')
  const amtStr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount)
  const msg =
    `\u{1F9FE} *Relish Accounts \u2014 Payment Processed*\n\n` +
    `Hi ${name},\n\n` +
    `Payment of *${amtStr}* (Voucher: ${voucherNo}) from *${companyCode}* ` +
    `has been processed to your account.\n\n` +
    `\u2014 Relish Accounts`
  return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`
}

function maskMobile(mobile?: string | null): string | null {
  if (!mobile) return null
  const digits = mobile.replace(/\D/g, '')
  if (digits.length < 4) return '****'
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`
}

function defaultFilters(): RegisterFilters {
  const today = new Date()
  // Default to current Indian financial year (Apr 1 – today)
  const fyYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1
  const fyStart = new Date(fyYear, 3, 1) // April 1
  return {
    status:   '',
    nature:   '',
    dateFrom: fyStart.toISOString().slice(0, 10),
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
    case 'completed':
    case 'approved':
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

// ── OTP panel (persistent for approved vouchers) ────────────────────────────

interface PersistentOtpPanelProps {
  voucherId: string
  companyId: string
  userId: string
  entityId: string | null
  mobileMasked: string | null
  onVerified: () => void
}

// ── WA send button for completed vouchers ───────────────────────────────────

interface WaPaymentBtnProps {
  mobile: string | null
  name: string | null
  amount: number
  voucherNo: string
  companyCode: string
  entityId: string | null
  onSmsSent: () => void
}

function WaPaymentBtn({ mobile, name, amount, voucherNo, companyCode, entityId, onSmsSent }: WaPaymentBtnProps) {
  const [smsSent, setSmsSent] = useState(false)
  const handleSendSms = async () => {
    if (!entityId) return
    await sendPaymentConfirmedSms(entityId, amount, voucherNo)
    setSmsSent(true)
    toast.success('Payment confirmation SMS sent')
    onSmsSent()
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
      {mobile ? (
        <a
          href={buildWhatsAppPaymentUrl(mobile, name ?? 'Payee', amount, voucherNo, companyCode)}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.waBtn}
          title="Open WhatsApp with pre-filled payment confirmation"
        >
          WhatsApp
        </a>
      ) : (
        <span className={styles.noMobile}>No payee mobile on file</span>
      )}
      {entityId && (
        <button
          type="button"
          className={styles.btnSecondary}
          style={{ fontSize: '0.8125rem' }}
          onClick={handleSendSms}
          disabled={smsSent}
        >
          {smsSent ? '✓ SMS Sent' : 'Send SMS Confirmation'}
        </button>
      )}
    </div>
  )
}

function PersistentOtpPanel({
  voucherId,
  companyId,
  userId,
  entityId,
  mobileMasked,
  onVerified,
}: PersistentOtpPanelProps) {
  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''))
  const [verifying, setVerifying] = useState(false)
  const [resending, setResending] = useState(false)
  const [otpError, setOtpError] = useState<string | null>(null)
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startCooldown = useCallback(() => {
    if (cooldownRef.current) clearInterval(cooldownRef.current)
    setCooldown(OTP_RESEND_COOLDOWN_SECONDS)
    cooldownRef.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          if (cooldownRef.current) clearInterval(cooldownRef.current)
          return 0
        }
        return c - 1
      })
    }, 1000)
  }, [])

  useEffect(() => {
    inputRefs.current[0]?.focus()
    startCooldown()
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current)
    }
  }, [startCooldown])

  const handleDigitChange = (index: number, value: string) => {
    const digit = value.replace(/\D/g, '').slice(-1)
    const next = [...digits]
    next[index] = digit
    setDigits(next)
    setOtpError(null)
    if (digit && index < OTP_LENGTH - 1) inputRefs.current[index + 1]?.focus()
  }

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH)
    if (!pasted) return
    e.preventDefault()
    const next = Array(OTP_LENGTH).fill('')
    pasted.split('').forEach((d, i) => {
      next[i] = d
    })
    setDigits(next)
    setOtpError(null)
    const focusIdx = Math.min(pasted.length, OTP_LENGTH - 1)
    inputRefs.current[focusIdx]?.focus()
  }

  const handleVerify = async () => {
    const code = digits.join('')
    if (code.length < OTP_LENGTH) {
      setOtpError('Enter all 6 digits')
      return
    }

    setVerifying(true)
    setOtpError(null)
    try {
      const result = await verifyPaymentOtp(voucherId, code, userId)
      if (result.verified) {
        toast.success('OTP verified — voucher completed')
        onVerified()
      } else if (result.error === 'invalid_otp') {
        const left = result.attempts_left ?? 0
        setAttemptsLeft(left)
        setOtpError(
          left === 0
            ? 'Incorrect OTP. No attempts remaining.'
            : `Incorrect OTP. ${left} attempt${left === 1 ? '' : 's'} remaining.`
        )
        setDigits(Array(OTP_LENGTH).fill(''))
        inputRefs.current[0]?.focus()
      } else if (result.error === 'max_attempts') {
        setAttemptsLeft(0)
        setOtpError('OTP locked after 3 failed attempts. Please resend OTP.')
      } else {
        setOtpError('OTP expired or not found. Please resend OTP.')
      }
    } catch (err: unknown) {
      setOtpError(err instanceof Error ? err.message : 'OTP verification failed')
    } finally {
      setVerifying(false)
    }
  }

  const handleResend = async () => {
    if (cooldown > 0 || resending) return
    setResending(true)
    setOtpError(null)
    setDigits(Array(OTP_LENGTH).fill(''))
    setAttemptsLeft(null)
    try {
      const result = await initiatePaymentOtp(voucherId, companyId, userId, entityId)
      if (result.sent) {
        toast.success(`OTP resent to ${result.mobile_masked}`)
        startCooldown()
        inputRefs.current[0]?.focus()
      } else {
        const reason = 'reason' in result ? result.reason : 'unknown'
        toast.error(`Could not resend OTP: ${reason}`)
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Resend failed')
    } finally {
      setResending(false)
    }
  }

  return (
    <div className={styles.otpPanel}>
      <div className={styles.otpHeader}>
        <div>
          <div className={styles.otpTitle}>Payee OTP Verification Required</div>
          {mobileMasked && (
            <div className={styles.otpSub}>OTP will be sent to <strong>+91 {mobileMasked}</strong></div>
          )}
          <div className={styles.otpSub}>Resend and verify until OTP is successfully entered.</div>
        </div>
      </div>

      <div className={styles.otpInputRow} onPaste={handlePaste}>
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => { inputRefs.current[i] = el }}
            type="text"
            inputMode="numeric"
            maxLength={2}
            value={d}
            onChange={(e) => handleDigitChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            className={`${styles.otpDigit} ${otpError ? styles.otpDigitError : ''}`}
            autoComplete="one-time-code"
          />
        ))}
        <button
          type="button"
          className={styles.otpVerifyBtn}
          onClick={handleVerify}
          disabled={verifying || digits.join('').length < OTP_LENGTH}
        >
          {verifying ? <Loader2 size={13} className={styles.spin} /> : <CheckCircle size={13} />}
          Verify
        </button>
      </div>

      {otpError && (
        <p className={styles.otpError}>
          <AlertCircle size={12} /> {otpError}
        </p>
      )}

      <div className={styles.otpFooter}>
        <button
          type="button"
          className={styles.otpResendBtn}
          onClick={handleResend}
          disabled={cooldown > 0 || resending}
        >
          {resending ? <Loader2 size={12} className={styles.spin} /> : <RotateCcw size={12} />}
          {cooldown > 0 ? `Resend OTP (${cooldown}s)` : 'Resend OTP'}
        </button>
        {attemptsLeft !== null && attemptsLeft > 0 && (
          <span className={styles.otpAttemptsNote}>
            ⚠ {attemptsLeft} attempt{attemptsLeft === 1 ? '' : 's'} remaining
          </span>
        )}
        {attemptsLeft === null && (
          <span className={styles.otpAttemptsNote}>3 attempts allowed</span>
        )}
      </div>
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
  onReloadPanel: (voucherId: string) => Promise<void>
}

function DetailPanel({
  row, detail, loading, attachments,
  companyId, companyCode, userId, role,
  onClose, onRefresh, onReloadPanel,
}: DetailPanelProps) {
  const navigate = useNavigate()
  const [actioning,      setActioning]      = useState(false)
  const [confirmDelete,  setConfirmDelete]  = useState(false)
  const [confirmDeletePending, setConfirmDeletePending] = useState(false)
  const [uploadingReceipt, setUploadingReceipt] = useState(false)
  const receiptInputRef = useRef<HTMLInputElement | null>(null)

  const isAdmin   = role === 'admin' || role === 'super_admin'
  const canManageOtp = role === 'admin' || role === 'accounts' || role === 'super_admin'
  const canUploadReceipt = role === 'admin' || role === 'accounts' || role === 'super_admin'
  const isAuditor = role === 'auditor'
  const canRecall = row && (row.created_by === userId || isAdmin)

  // Reset confirm state when panel changes
  useEffect(() => {
    setConfirmDelete(false)
    setConfirmDeletePending(false)
  }, [row?.id])

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

  const handleEditPending = async () => {
    if (!row) return
    setActioning(true)
    try {
      await recallVoucher(row.id)
      toast.success('Voucher recalled to draft for editing')
      navigate(`/vouchers/${row.id}/edit`)
      onRefresh(); onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to recall for edit')
    } finally { setActioning(false) }
  }

  const handleDeletePending = async () => {
    if (!row) return
    setActioning(true)
    try {
      await recallVoucher(row.id)
      await deleteVoucher(row.id)
      toast.success('Pending voucher deleted')
      onRefresh(); onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete pending voucher')
    } finally {
      setActioning(false)
      setConfirmDeletePending(false)
    }
  }

  const handlePrintVoucherCopy = () => {
    if (!row || !detail) return
    const win = window.open('', '_blank', 'width=900,height=700')
    if (!win) {
      toast.error('Please allow pop-ups to open voucher copy')
      return
    }

    const entriesHtml = detail.entries.map((e) => `
      <tr>
        <td>${escapeHtml(e.ledger_name)}</td>
        <td>${escapeHtml(e.group_name ?? '—')}</td>
        <td style="text-align:right;">${e.entry_type === 'Dr' ? formatIndianCurrency(e.amount) : ''}</td>
        <td style="text-align:right;">${e.entry_type === 'Cr' ? formatIndianCurrency(e.amount) : ''}</td>
      </tr>
    `).join('')

    const html = `<!doctype html>
      <html>
        <head>
          <title>${escapeHtml(row.voucher_number)} — Voucher Copy</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
            h1 { margin: 0 0 8px; font-size: 22px; }
            h2 { margin: 22px 0 10px; font-size: 16px; }
            .meta { display:grid; grid-template-columns: 180px 1fr; gap: 8px 12px; }
            .label { color:#555; font-weight:700; }
            table { width:100%; border-collapse: collapse; margin-top: 10px; }
            th, td { border:1px solid #ccc; padding:8px; font-size: 13px; }
            th { background:#f4f4f4; text-align:left; }
            .topline { display:flex; justify-content:space-between; align-items:flex-start; gap: 16px; }
            .status { padding:4px 10px; border:1px solid #999; border-radius:999px; font-size:12px; }
          </style>
        </head>
        <body>
          <div class="topline">
            <div>
              <h1>Voucher Copy</h1>
              <div><strong>${escapeHtml(row.voucher_number)}</strong></div>
            </div>
            <div class="status">${escapeHtml(row.status.toUpperCase())}</div>
          </div>
          <h2>Voucher Details</h2>
          <div class="meta">
            <div class="label">Company</div><div>${escapeHtml(companyCode)}</div>
            <div class="label">Date</div><div>${escapeHtml(fmtDate(detail.voucher_date))}</div>
            <div class="label">Type</div><div>${escapeHtml(detail.voucher_type.name)}</div>
            <div class="label">Party</div><div>${escapeHtml(detail.entity_name ?? '—')}</div>
            <div class="label">Amount</div><div>${escapeHtml(formatIndianCurrency(detail.amount))}</div>
            <div class="label">Payment Mode</div><div>${escapeHtml(detail.payment_mode ?? '—')}</div>
            <div class="label">Reference</div><div>${escapeHtml(detail.ref_document_number ?? detail.utr_number ?? '—')}</div>
            <div class="label">Narration</div><div>${escapeHtml(detail.narration ?? '—')}</div>
            <div class="label">Created By</div><div>${escapeHtml(detail.created_by_name)}</div>
          </div>
          <h2>Accounting Entries</h2>
          <table>
            <thead>
              <tr><th>Ledger</th><th>Group</th><th>Dr</th><th>Cr</th></tr>
            </thead>
            <tbody>${entriesHtml}</tbody>
          </table>
        </body>
      </html>`

    win.document.open()
    win.document.write(html)
    win.document.close()
    win.focus()
  }

  const handleUploadReceiptFiles = async (files: FileList | null) => {
    if (!files || !detail?.id) return
    const list = Array.from(files)
    if (list.length === 0) return

    setUploadingReceipt(true)
    try {
      const result = await uploadVoucherAttachments(detail.id, companyId, userId, list)
      if (result.ok.length > 0) {
        toast.success(`${result.ok.length} receipt${result.ok.length === 1 ? '' : 's'} attached`)
      }
      if (result.failed.length > 0) {
        toast.warning(`Failed to attach: ${result.failed.join(', ')}`)
      }
      await onReloadPanel(detail.id)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to upload receipt')
    } finally {
      setUploadingReceipt(false)
      if (receiptInputRef.current) receiptInputRef.current.value = ''
    }
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

            {row?.status === 'completed' && canUploadReceipt && (
              <div className={styles.receiptUploadBox}>
                <div className={styles.receiptUploadText}>
                  Attach bank/UPI transaction receipts after payment completion.
                </div>
                <input
                  ref={receiptInputRef}
                  type="file"
                  multiple
                  accept="image/*,application/pdf"
                  className={styles.hiddenFileInput}
                  onChange={(e) => void handleUploadReceiptFiles(e.target.files)}
                />
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => receiptInputRef.current?.click()}
                  disabled={uploadingReceipt}
                >
                  {uploadingReceipt ? <Loader2 size={13} className={styles.spin} /> : <Paperclip size={13} />}
                  Attach Transaction Receipt
                </button>
              </div>
            )}

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
                  {isAdmin && (
                    <button
                      className={styles.btnSecondary}
                      onClick={handleEditPending}
                      disabled={actioning}
                    >
                      {actioning ? <Loader2 size={13} className={styles.spin} /> : <Edit3 size={13} />}
                      Edit (Recall)
                    </button>
                  )}
                  {isAdmin && !confirmDeletePending && (
                    <button
                      className={styles.btnDanger}
                      onClick={() => setConfirmDeletePending(true)}
                      disabled={actioning}
                    >
                      <Trash2 size={13} /> Delete (Recall)
                    </button>
                  )}
                  {isAdmin && confirmDeletePending && (
                    <div className={styles.confirmRow}>
                      <span className={styles.confirmText}>Recall and permanently delete this pending voucher?</span>
                      <button className={styles.btnDanger} onClick={handleDeletePending} disabled={actioning}>
                        {actioning ? <Loader2 size={12} className={styles.spin} /> : null}
                        Yes, delete
                      </button>
                      <button className={styles.btnSecondary} onClick={() => setConfirmDeletePending(false)}>
                        Cancel
                      </button>
                    </div>
                  )}
                </>
              )}

              {/* Posted / Completed — WhatsApp + SMS confirmation ─────── */}
              {(row.status === 'posted' || row.status === 'completed' || row.status === 'approved') && (
                <div className={styles.panelSection} style={{ borderTop: '1px solid var(--border)', marginTop: '0.25rem' }}>
                  <div className={styles.sectionHeader} style={{ marginBottom: '0.5rem' }}>Payment Confirmation</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.625rem' }}>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={handlePrintVoucherCopy}
                    >
                      <FileText size={13} /> Voucher Copy
                    </button>
                    <span className={styles.paymentConfirmNote}>
                      SMS and WhatsApp can send a message, but cannot auto-attach the voucher PDF/file.
                    </span>
                  </div>
                  <WaPaymentBtn
                    mobile={detail.entity_mobile ?? null}
                    name={detail.entity_name ?? null}
                    amount={detail.amount}
                    voucherNo={row.voucher_number}
                    companyCode={companyCode}
                    entityId={detail.entity_id}
                    onSmsSent={onRefresh}
                  />
                </div>
              )}

              {/* Approved (OTP pending) */}
              {row.status === 'approved' && canManageOtp && (
                <>
                  <div className={styles.otpInlineWrap}>
                    <PersistentOtpPanel
                      voucherId={row.id}
                      companyId={companyId}
                      userId={userId}
                      entityId={detail.entity_id}
                      mobileMasked={maskMobile(detail.entity_mobile)}
                      onVerified={() => {
                        onRefresh()
                        onClose()
                      }}
                    />
                  </div>
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
  // ── Export ───────────────────────────────────────────────────────────────────
  const [exportOpen, setExportOpen] = useState(false)
  const exportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!exportOpen) return
    function onClickOutside(e: MouseEvent) {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [exportOpen])

  function rowsToRecords(rows: RegisterVoucher[]): VoucherRecord[] {
    return rows.map(r => ({
      voucherNo:      r.voucher_number,
      voucherDate:    r.voucher_date,
      voucherType:    r.voucher_type.name,
      nature:         r.voucher_type.nature,
      referenceNo:    null,
      supplierName:   r.entity_name ?? null,
      supplierGstin:  null,
      supplierState:  null,
      recipientName:  null,
      recipientGstin: null,
      recipientState: null,
      gstType:        null,
      hsnCode:        null,
      narration:      r.narration ?? null,
      taxableValue:   r.amount,
      cgstAmount:     0,
      sgstAmount:     0,
      igstAmount:     0,
      totalGst:       0,
      invoiceTotal:   r.amount,
      itcEligible:    true,
      ocrConfidence:  null,
      status:         r.status,
      createdAt:      r.created_at,
      lineItems:      [],
    }))
  }

  function handleExport(format: 'summary' | 'lineitems') {
    if (allRows.length === 0) { toast.error('No vouchers to export'); return }
    exportVouchersCsv(rowsToRecords(allRows), format, filters.dateFrom, filters.dateTo)
    setExportOpen(false)
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

  const loadPanelData = useCallback(async (id: string) => {
    setPanelLoading(true)
    try {
      const [voucherDetail, voucherAttachments] = await Promise.all([
        fetchVoucherFull(id),
        fetchVoucherAttachments(id),
      ])
      setDetail(voucherDetail)
      setAttachments(voucherAttachments)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load voucher')
    } finally {
      setPanelLoading(false)
    }
  }, [])

  const openPanel = (id: string) => {
    if (id === selectedId) { closePanel(); return }
    setSelectedId(id)
    setDetail(null)
    setAttachments([])
    void loadPanelData(id)
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
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {/* Export dropdown */}
          <div ref={exportRef} style={{ position: 'relative' }}>
            <button
              className={styles.newBtn}
              style={{ background: 'none', border: '1px solid #d9d6cf', color: '#444' }}
              onClick={() => setExportOpen(o => !o)}
              aria-haspopup="true"
              aria-expanded={exportOpen}
            >
              <Download size={14} /> Export <ChevronDown size={12} />
            </button>
            {exportOpen && (
              <div style={{
                position: 'absolute', right: 0, top: '100%', marginTop: 4,
                background: '#fff', border: '1px solid #e8e6e1', borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 50,
                minWidth: 220, overflow: 'hidden',
              }}>
                <button
                  style={menuItem}
                  onClick={() => handleExport('summary')}
                >
                  All filtered vouchers — Summary CSV
                </button>
                <button
                  style={menuItem}
                  onClick={() => handleExport('lineitems')}
                >
                  All filtered vouchers — Line Items CSV
                </button>
                <div style={{ borderTop: '1px solid #f0efeb' }}>
                  <button style={{ ...menuItem, color: '#bbb', cursor: 'default' }} disabled>
                    Export for Tally&nbsp;<span style={{
                      fontSize: '0.6875rem', background: '#f0efeb',
                      color: '#888', borderRadius: 4, padding: '1px 5px',
                    }}>Soon</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          <button className={styles.newBtn} onClick={() => navigate('/vouchers/new')}>
            <Plus size={14} /> New Voucher
          </button>
        </div>
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
          onReloadPanel={loadPanelData}
        />

      </div>
    </div>
  )
}
