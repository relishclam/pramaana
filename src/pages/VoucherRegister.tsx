import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus, Search, X, ChevronRight, Loader2, CheckCircle, Clock, XCircle,
  AlertCircle, FileText, ExternalLink, Trash2, Edit3, Send, RotateCcw, BookOpen,
  Download, ChevronDown, Paperclip, CreditCard,
} from 'lucide-react'
import PayNowModal, { type PayNowVoucher } from '@/components/PayNowModal'
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
import { formatIndianCurrency } from '@/lib/vouchers'
import { queueForPayment, dequeuePayment, updateVoucherPaymentMode } from '@/lib/pay-now'
import {
  fetchAllocationsForPayment,
  fetchAllocationsForBill,
  type AllocationDetail,
  type BillPaymentDetail,
} from '@/lib/allocations'
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
  { label: 'All',              value: '' },
  { label: 'Drafts',           value: 'draft' },
  { label: 'Pending Approval', value: 'pending_approval' },
  { label: 'Awaiting OTP',     value: 'approved' },
  { label: 'OTP Verified',     value: 'completed' },
  { label: 'Awaiting Payment', value: 'awaiting_payment' },
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

// Bank transfer modes (these are the "Account Transfer" equivalent in Pramaana)
const BANK_TRANSFER_MODES = new Set(['Bank', 'Cheque', 'NEFT', 'RTGS', 'IMPS'])

function canSeePayNow(
  role: string | null,
  isSuperAdmin: boolean,
  paymentMode: string | null,
): boolean {
  if (!paymentMode || paymentMode === 'Cash') return false
  if (isSuperAdmin || role === 'admin') return true
  if (role === 'accounts' && BANK_TRANSFER_MODES.has(paymentMode)) return true
  return false
}

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

function fmtDateTimeLong(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function numberToIndianWords(amount: number) {
  const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']
  const TEENS = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

  const twoDigits = (n: number) => {
    if (n < 10) return ONES[n]
    if (n < 20) return TEENS[n - 10]
    return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`.trim()
  }

  const threeDigits = (n: number) => {
    if (n < 100) return twoDigits(n)
    return `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${twoDigits(n % 100)}` : ''}`.trim()
  }

  const toIndianUnits = (n: number) => {
    if (n === 0) return 'Zero'
    const parts: string[] = []
    const crore = Math.floor(n / 10000000)
    const lakh = Math.floor((n % 10000000) / 100000)
    const thousand = Math.floor((n % 100000) / 1000)
    const hundred = n % 1000

    if (crore) parts.push(`${threeDigits(crore)} Crore`)
    if (lakh) parts.push(`${threeDigits(lakh)} Lakh`)
    if (thousand) parts.push(`${threeDigits(thousand)} Thousand`)
    if (hundred) parts.push(threeDigits(hundred))
    return parts.join(' ').trim()
  }

  const rupees = Math.floor(amount)
  const paise = Math.round((amount - rupees) * 100)
  const rupeeWords = toIndianUnits(rupees)
  const paiseWords = paise ? ` and Paise ${toIndianUnits(paise)}` : ''
  return `Rupees ${rupeeWords}${paiseWords} Only`
}

function getVoucherBeneficiary(row: RegisterVoucher | null, detail: VoucherFull | null) {
  return detail?.entity_name ?? row?.entity_name ?? '—'
}

function getApprovalAction(detail: VoucherFull | null) {
  return detail?.history.find(item => item.action === 'approved') ?? null
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
  const IN_BOOKS = new Set(['approved', 'completed', 'awaiting_payment', 'posted'])
  let badge: React.ReactNode
  switch (status) {
    case 'draft':
      badge = <span className={`${styles.badge} ${styles.badgeDraft}`}>Draft</span>
      break
    case 'pending_approval':
      badge = (
        <span className={`${styles.badge} ${styles.badgePending}`}>
          <span className={styles.pulseDot} />
          Pending
        </span>
      )
      break
    case 'approved':
      badge = (
        <span className={`${styles.badge} ${styles.badgePending}`}>
          <span className={styles.pulseDot} />
          Awaiting OTP
        </span>
      )
      break
    case 'completed':
      badge = <span className={`${styles.badge} ${styles.badgeCompleted}`}>OTP Verified</span>
      break
    case 'awaiting_payment':
      badge = (
        <span className={`${styles.badge} ${styles.badgePending}`}>
          <span className={styles.pulseDot} />
          Awaiting Payment
        </span>
      )
      break
    case 'posted':
      badge = <span className={`${styles.badge} ${styles.badgePosted}`}>Posted</span>
      break
    case 'cancelled':
      badge = <span className={`${styles.badge} ${styles.badgeCancelled}`}>Cancelled</span>
      break
    default:
      badge = <span className={`${styles.badge} ${styles.badgeDraft}`}>{status}</span>
  }
  return (
    <span className={styles.statusWrap}>
      {badge}
      {IN_BOOKS.has(status) && <span className={styles.inBooksTag}>in books</span>}
    </span>
  )
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
  mobile:      string | null
  name:        string | null
  amount:      number
  voucherNo:   string
  companyCode: string
}

function WaPaymentBtn({ mobile, name, amount, voucherNo, companyCode }: WaPaymentBtnProps) {
  if (!mobile) return <span className={styles.noMobile}>No payee mobile on file</span>
  return (
    <a
      href={buildWhatsAppPaymentUrl(mobile, name ?? 'Payee', amount, voucherNo, companyCode)}
      target="_blank"
      rel="noopener noreferrer"
      className={styles.waBtn}
      title="Open WhatsApp with pre-filled payment confirmation"
    >
      WhatsApp
    </a>
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
  companyName: string
  userId:      string
  role:        string | null
  isSuperAdmin: boolean
  onClose:     () => void
  onRefresh:   () => void
  onReloadPanel: (voucherId: string) => Promise<void>
  onPayNow:    (v: PayNowVoucher) => void
}

function DetailPanel({
  row, detail, loading, attachments,
  companyId, companyCode, companyName, userId, role, isSuperAdmin,
  onClose, onRefresh, onReloadPanel, onPayNow,
}: DetailPanelProps) {
  if (!row) return null

  const navigate = useNavigate()
  const [actioning,      setActioning]      = useState(false)
  const [confirmDelete,  setConfirmDelete]  = useState(false)
  const [confirmDeletePending, setConfirmDeletePending] = useState(false)
  const [uploadingReceipt, setUploadingReceipt] = useState(false)
  const [uploadingDoc,     setUploadingDoc]     = useState(false)
  const [queueing,       setQueueing]       = useState(false)
  const [settingMode,    setSettingMode]    = useState(false)
  const [pendingMode,    setPendingMode]    = useState('')
  const receiptInputRef = useRef<HTMLInputElement | null>(null)
  const docInputRef     = useRef<HTMLInputElement | null>(null)

  const isAdmin   = role === 'admin' || role === 'super_admin'
  const canManageOtp = role === 'admin' || role === 'accounts' || role === 'super_admin'
  const canUploadReceipt = role === 'admin' || role === 'accounts' || role === 'super_admin'
  const isAuditor = role === 'auditor'
  const canRecall = row && (row.created_by === userId || isAdmin)
  const beneficiaryName = getVoucherBeneficiary(row, detail)
  const approvalAction = getApprovalAction(detail)

  // ── Bill allocation data (loaded per voucher when panel opens) ────────────
  const [paymentAllocs, setPaymentAllocs] = useState<AllocationDetail[]>([])
  const [billPayments,  setBillPayments]  = useState<BillPaymentDetail[]>([])
  const [allocLoading,  setAllocLoading]  = useState(false)

  useEffect(() => {
    if (!detail?.id) { setPaymentAllocs([]); setBillPayments([]); return }
    const nature = detail.voucher_type.nature
    if (nature !== 'payment' && nature !== 'receipt' && nature !== 'purchase' && nature !== 'sales') return
    setAllocLoading(true)
    if (nature === 'payment' || nature === 'receipt') {
      fetchAllocationsForPayment(detail.id)
        .then(setPaymentAllocs).catch(() => setPaymentAllocs([]))
        .finally(() => setAllocLoading(false))
    } else {
      fetchAllocationsForBill(detail.id)
        .then(setBillPayments).catch(() => setBillPayments([]))
        .finally(() => setAllocLoading(false))
    }
  }, [detail?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const traceabilityStamps = [
    {
      label: 'Created by',
      name: detail?.created_by_name ?? row?.created_by_name ?? '—',
      time: detail?.created_at ?? row?.created_at ?? null,
      note: 'Prepared By',
    },
    {
      label: 'Approved by',
      name: approvalAction?.actioned_by_name ?? detail?.posted_by_name ?? '—',
      time: approvalAction?.actioned_at ?? detail?.posted_at ?? null,
      note: 'Approved By',
    },
    {
      label: 'OTP Verified',
      name: detail?.otp_verified_by_name ?? detail?.completed_by_name ?? '—',
      time: detail?.otp_verified_at ?? detail?.completed_at ?? null,
      note: 'Payee Signature',
    },
  ].filter(stamp => stamp.time || stamp.name !== '—')

  // Reset confirm state when panel changes
  useEffect(() => {
    setConfirmDelete(false)
    setConfirmDeletePending(false)
  }, [row?.id])

  useEffect(() => {
    if (!row) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [row, onClose])

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

    const drTotal = detail.entries.reduce((sum, e) => e.entry_type === 'Dr' ? sum + e.amount : sum, 0)
    const crTotal = detail.entries.reduce((sum, e) => e.entry_type === 'Cr' ? sum + e.amount : sum, 0)

    const stampCards = traceabilityStamps.map((stamp) => `
      <div class="stampCard">
        <div class="stampName">${escapeHtml(stamp.name)}</div>
        <div class="stampRole">${escapeHtml(stamp.label)}</div>
        <div class="stampTime">${escapeHtml(fmtDateTimeLong(stamp.time))}</div>
        <div class="stampNote">${escapeHtml(stamp.note)}</div>
      </div>
    `).join('')

    // Build attachment section: text list + embedded image previews
    const attachmentTypeLabel: Record<string, string> = {
      invoice:          'Invoice',
      transfer_receipt: 'Transfer Receipt',
      other:            'Supporting Document',
    }

    const attachmentListRows = attachments.map((att, i) => {
      const isImage  = att.mime_type?.startsWith('image/') ?? false
      const typeLabel = attachmentTypeLabel[att.attachment_type] ?? att.attachment_type
      // All attachments get a clickable link — signed URLs are valid for 1 hour from
      // print time, which covers the typical "print and send to payee" use case.
      const nameCell = att.signed_url
        ? `<a href="${att.signed_url}" target="_blank" style="color:#6d4aa2;text-decoration:none;font-weight:600">${escapeHtml(att.file_name)}&nbsp;&#8599;</a>`
        : escapeHtml(att.file_name)
      return `
        <tr>
          <td class="attachNum">${i + 1}</td>
          <td class="attachName">
            ${nameCell}
            <span class="attachTypeBadge">${escapeHtml(typeLabel)}</span>
          </td>
          <td class="attachSize">${escapeHtml(att.file_size ? formatFileSize(att.file_size) : '—')}</td>
          <td class="attachFormat">${isImage ? 'Image (preview ↓)' : 'PDF / Doc'}</td>
        </tr>
      `
    }).join('')

    const attachmentImagePreviews = attachments
      .filter(att => att.mime_type?.startsWith('image/') && att.signed_url)
      .map((att, i) => `
        <div class="attachPreview">
          <div class="attachPreviewLabel">${escapeHtml(att.file_name)}</div>
          <img class="attachPreviewImg" src="${att.signed_url}" alt="${escapeHtml(att.file_name)}" />
        </div>
      `).join('')

    const attachmentSection = `
      <div class="attachSection">
        <div class="sectionTitle">Supporting Documents</div>
        ${attachments.length === 0
          ? `<div class="attachNone">No attachments on this voucher.</div>`
          : `
            <table class="attachTable">
              <thead>
                <tr>
                  <th class="attachNum">#</th>
                  <th>File Name</th>
                  <th class="attachSize">Size</th>
                  <th class="attachFormat">Type</th>
                </tr>
              </thead>
              <tbody>${attachmentListRows}</tbody>
            </table>
            ${attachmentImagePreviews ? `
              <div class="attachPreviews">${attachmentImagePreviews}</div>
            ` : ''}
          `
        }
      </div>
    `

    const html = `<!doctype html>
      <html>
        <head>
          <title>${escapeHtml(row.voucher_number)} — Voucher Copy</title>
          <style>
            @page { size: A4; margin: 14mm; }
            * { box-sizing: border-box; }
            body {
              font-family: Arial, Helvetica, sans-serif;
              margin: 0;
              color: #111;
              background: #fff;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
            .sheet {
              width: 100%;
              max-width: 980px;
              margin: 0 auto;
              padding: 0;
            }
            .headerTitle { text-align: center; margin: 0; font-size: 26px; font-weight: 700; }
            .headerSub { text-align: center; color: #666; margin: 4px 0 18px; font-size: 12px; }
            .voucherBox { border: 1px solid #d9d9d9; padding: 14px 16px 16px; }
            .orgName { text-align: center; color: #6d4aa2; font-size: 18px; font-weight: 700; margin: 0; }
            .orgAddress { text-align: center; color: #6b6b6b; font-size: 11px; margin: 4px 0 0; }
            .voucherType {
              text-align: center;
              color: #f28c13;
              font-size: 20px;
              font-weight: 700;
              letter-spacing: 0.16em;
              margin: 16px 0 12px;
            }
            .rule { border-top: 2px solid #333; margin: 10px 0 14px; }
            .metaGrid {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 10px 24px;
            }
            .metaItem { font-size: 13px; line-height: 1.35; }
            .metaLabel { display: inline-block; width: 140px; font-weight: 700; color: #222; }
            .sectionTitle { margin: 16px 0 8px; font-size: 14px; font-weight: 700; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #dedede; padding: 7px 8px; font-size: 12px; vertical-align: top; }
            th { background: #f8a21a; color: #fff; text-align: left; }
            .right { text-align: right; }
            .totalRow td { background: #fff4d9; font-weight: 700; border-top: 2px solid #f0a000; }
            .amountWords { margin-top: 6px; font-size: 12px; font-style: italic; color: #a85f00; }
            .stampRow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 28px; }
            .stampCard { text-align: center; border-top: 1px solid #222; padding-top: 10px; min-height: 88px; }
            .stampName { font-size: 14px; font-weight: 700; margin-bottom: 2px; }
            .stampRole { font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
            .stampTime { font-size: 11px; color: #f28c13; margin-bottom: 4px; }
            .stampNote { font-size: 11px; color: #555; }
            .attachSection { margin-top: 18px; }
            .attachSection .sectionTitle { margin: 0 0 8px; font-size: 13px; font-weight: 700; }
            .attachTable { width: 100%; border-collapse: collapse; }
            .attachTable th { background: #f0f0f0; color: #333; font-size: 11px; text-align: left; padding: 5px 8px; border: 1px solid #ccc; }
            .attachTable td { border: 1px solid #e0e0e0; padding: 5px 8px; font-size: 11px; }
            .attachNum { width: 36px; text-align: center; color: #888; }
            .attachName { word-break: break-all; }
            .attachSize { width: 72px; text-align: right; color: #888; white-space: nowrap; }
            .attachFormat { width: 80px; color: #888; }
            .attachTypeBadge {
              display: inline-block; margin-left: 6px;
              background: #f0eaf8; color: #6d4aa2;
              font-size: 10px; padding: 1px 5px; border-radius: 3px;
            }
            .attachNone { font-size: 12px; color: #999; font-style: italic; padding: 4px 0; }
            .attachPreviews { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 14px; }
            .attachPreview { flex: 0 0 auto; max-width: 45%; }
            .attachPreviewLabel { font-size: 10px; color: #666; margin-bottom: 4px; word-break: break-all; }
            .attachPreviewImg { width: 100%; max-width: 380px; border: 1px solid #ddd; border-radius: 4px; display: block; }
          </style>
        </head>
        <body>
          <div class="sheet">
            <h1 class="headerTitle">Voucher</h1>
            <div class="headerSub">Generated on ${escapeHtml(fmtDateTimeLong(new Date().toISOString()))}</div>
            <div class="rule"></div>

            <div class="voucherBox">
              <p class="orgName">${escapeHtml(companyName)}</p>
              <div class="voucherType">PAYMENT VOUCHER</div>

              <div class="rule"></div>

              <div class="metaGrid">
                <div class="metaItem"><span class="metaLabel">Voucher No:</span> ${escapeHtml(row.voucher_number)}</div>
                <div class="metaItem"><span class="metaLabel">Date:</span> ${escapeHtml(fmtDateTimeLong(detail.voucher_date))}</div>
                <div class="metaItem"><span class="metaLabel">Payee:</span> ${escapeHtml(beneficiaryName)}</div>
                <div class="metaItem"><span class="metaLabel">Payment Mode:</span> ${escapeHtml(detail.payment_mode ?? '—')}</div>
                <div class="metaItem"><span class="metaLabel">Head of Account:</span> ${escapeHtml(detail.entries[0]?.group_name ?? detail.entries[0]?.ledger_name ?? '—')}</div>
                <div class="metaItem"><span class="metaLabel">Status:</span> ${escapeHtml(row.status.toUpperCase())}</div>
              </div>

              <div class="sectionTitle">Particulars</div>
              <table>
                <thead>
                  <tr>
                    <th style="width: 56px;">S.No.</th>
                    <th>Description</th>
                    <th style="width: 110px;" class="right">Dr (₹)</th>
                    <th style="width: 110px;" class="right">Cr (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  ${detail.entries.map((e, index) => `
                    <tr>
                      <td class="right">${index + 1}</td>
                      <td>${escapeHtml(e.ledger_name)}${e.narration ? ` <span style="color:#777;">(${escapeHtml(e.narration)})</span>` : ''}</td>
                      <td class="right">${e.entry_type === 'Dr' ? escapeHtml(formatIndianCurrency(e.amount)) : ''}</td>
                      <td class="right">${e.entry_type === 'Cr' ? escapeHtml(formatIndianCurrency(e.amount)) : ''}</td>
                    </tr>
                  `).join('')}
                  <tr class="totalRow">
                    <td></td>
                    <td class="right">TOTAL:</td>
                    <td class="right">${escapeHtml(formatIndianCurrency(drTotal))}</td>
                    <td class="right">${escapeHtml(formatIndianCurrency(crTotal))}</td>
                  </tr>
                </tbody>
              </table>

              <div class="amountWords"><strong>In Words:</strong> ${escapeHtml(numberToIndianWords(detail.amount))}</div>

              ${attachmentSection}

              <div class="stampRow">
                ${stampCards}
              </div>
            </div>
          </div>
        </body>
      </html>`

    const blob = new Blob([html], { type: 'text/html; charset=utf-8' })
    const blobUrl = URL.createObjectURL(blob)
    const win = window.open(blobUrl, '_blank', 'width=900,height=700')
    if (!win) {
      URL.revokeObjectURL(blobUrl)
      toast.error('Please allow pop-ups to open voucher copy')
      return
    }
    win.addEventListener('load', () => {
      win.print()
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
    })
  }

  const handleQueueForPayment = async () => {
    if (!row) return
    setQueueing(true)
    try {
      await queueForPayment(row.id, userId)
      toast.success('Voucher queued for payment')
      onRefresh()
      await onReloadPanel(row.id)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to queue voucher')
    } finally { setQueueing(false) }
  }

  const handleDequeue = async () => {
    if (!row) return
    setQueueing(true)
    try {
      await dequeuePayment(row.id)
      toast.success('Voucher removed from payment queue')
      onRefresh()
      await onReloadPanel(row.id)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to dequeue voucher')
    } finally { setQueueing(false) }
  }

  const handleSetPaymentMode = async () => {
    if (!row || !pendingMode) return
    setSettingMode(true)
    try {
      await updateVoucherPaymentMode(row.id, pendingMode)
      toast.success('Payment mode set')
      setPendingMode('')
      onRefresh()
      await onReloadPanel(row.id)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to set payment mode')
    } finally { setSettingMode(false) }
  }

  const handleUploadReceiptFiles = async (files: FileList | null) => {
    if (!files || !detail?.id) return
    const list = Array.from(files)
    if (list.length === 0) return

    setUploadingReceipt(true)
    try {
      const result = await uploadVoucherAttachments(detail.id, companyId, userId, list, 'transfer_receipt')
      if (result.ok.length > 0) {
        toast.success(`${result.ok.length} receipt${result.ok.length === 1 ? '' : 's'} attached`)
        // Auto-open WhatsApp payment confirmation so staff can notify payee immediately
        if (row && detail.entity_mobile) {
          const waUrl = buildWhatsAppPaymentUrl(
            detail.entity_mobile,
            detail.entity_name ?? 'Payee',
            detail.amount,
            row.voucher_number,
            companyCode,
          )
          window.open(waUrl, '_blank', 'noopener,noreferrer')
        }
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

  const handleUploadDocFiles = async (files: FileList | null) => {
    if (!files || !detail?.id) return
    const list = Array.from(files)
    if (list.length === 0) return

    setUploadingDoc(true)
    try {
      const result = await uploadVoucherAttachments(detail.id, companyId, userId, list, 'invoice')
      if (result.ok.length > 0) {
        toast.success(`${result.ok.length} document${result.ok.length === 1 ? '' : 's'} attached`)
      }
      if (result.failed.length > 0) {
        toast.warning(`Failed to attach: ${result.failed.join(', ')}`)
      }
      await onReloadPanel(detail.id)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to upload document')
    } finally {
      setUploadingDoc(false)
      if (docInputRef.current) docInputRef.current.value = ''
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose} role="presentation">
      <aside className={styles.modalShell} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.modalHeader}>
          <div className={styles.panelHeaderLeft}>
            <span className={styles.panelVoucherNo}>{row.voucher_number}</span>
            <StatusBadge status={row.status} />
          </div>
          <div className={styles.modalHeaderActions}>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={handlePrintVoucherCopy}
              disabled={loading || !detail}
            >
              <FileText size={13} /> Print
            </button>
            <button className={styles.panelClose} onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
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
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Payee / Beneficiary</span>
                <span className={styles.metaValue}>{beneficiaryName}</span>
              </div>
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

          {/* ── Traceability ───────────────────────────────────────────── */}
          <div className={styles.panelSection}>
            <div className={styles.sectionHeader}>Traceability</div>
            <div className={styles.traceGrid}>
              <div className={styles.traceCard}>
                <div className={styles.traceName}>{detail.created_by_name}</div>
                <div className={styles.traceRole}>Created by</div>
                <div className={styles.traceTime}>{fmtDateTimeLong(detail.created_at)}</div>
              </div>
              <div className={styles.traceCard}>
                <div className={styles.traceName}>{approvalAction?.actioned_by_name ?? detail.posted_by_name ?? '—'}</div>
                <div className={styles.traceRole}>Approved by</div>
                <div className={styles.traceTime}>{fmtDateTimeLong(approvalAction?.actioned_at ?? detail.posted_at)}</div>
              </div>
              <div className={styles.traceCard}>
                <div className={styles.traceName}>{detail.otp_verified_by_name ?? detail.completed_by_name ?? '—'}</div>
                <div className={styles.traceRole}>OTP verified</div>
                <div className={styles.traceTime}>{fmtDateTimeLong(detail.otp_verified_at ?? detail.completed_at)}</div>
              </div>
            </div>
          </div>

          {/* ── Entries ─────────────────────────────────────────────── */}
          <div className={styles.panelSection}>
            <div className={styles.sectionHeader}>Accounting Entries</div>
            <EntriesTable entries={detail.entries} />
          </div>

          {/* ── Bill Allocation ──────────────────────────────────────── */}
          {(detail.voucher_type.nature === 'purchase' || detail.voucher_type.nature === 'sales') && (
            <div className={styles.panelSection}>
              <div className={styles.sectionHeader}>
                Bill Status
                {allocLoading && <Loader2 size={12} className={styles.spin} style={{ marginLeft: 6 }} />}
              </div>
              {!allocLoading && (() => {
                const totalPaid = billPayments.reduce((s, p) => s + p.amount_allocated, 0)
                const outstanding = Math.max(0, detail.amount - totalPaid)
                return (
                  <>
                    <div className={styles.metaGrid} style={{ marginBottom: billPayments.length ? '0.625rem' : 0 }}>
                      <div className={styles.metaItem}>
                        <span className={styles.metaLabel}>Total Paid</span>
                        <span className={styles.metaValue}>
                          {totalPaid > 0.005 ? formatIndianCurrency(totalPaid) : <span className={styles.dim}>—</span>}
                        </span>
                      </div>
                      <div className={styles.metaItem}>
                        <span className={styles.metaLabel}>Outstanding</span>
                        <span className={`${styles.metaValue} ${outstanding > 0.005 ? styles.allocOutstanding : styles.dim}`}>
                          {outstanding > 0.005 ? formatIndianCurrency(outstanding) : 'Fully settled'}
                        </span>
                      </div>
                    </div>
                    {billPayments.length > 0 && (
                      <div className={styles.allocTable}>
                        {billPayments.map(p => (
                          <div key={p.payment_voucher_id} className={styles.allocRow}>
                            <span className={styles.allocVno}>{p.payment_voucher_number}</span>
                            <span className={styles.allocDate}>{fmtDate(p.payment_voucher_date)}</span>
                            <span className={styles.allocAmt}>{formatIndianCurrency(p.amount_allocated)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {billPayments.length === 0 && (
                      <div className={styles.allocEmpty}>No payments allocated yet</div>
                    )}
                  </>
                )
              })()}
            </div>
          )}

          {(detail.voucher_type.nature === 'payment' || detail.voucher_type.nature === 'receipt') && (
            <div className={styles.panelSection}>
              <div className={styles.sectionHeader}>
                Bill Allocation
                {allocLoading && <Loader2 size={12} className={styles.spin} style={{ marginLeft: 6 }} />}
              </div>
              {!allocLoading && paymentAllocs.length === 0 && (
                <div className={styles.allocEmpty}>Not allocated to any bill</div>
              )}
              {!allocLoading && paymentAllocs.length > 0 && (
                <div className={styles.allocTable}>
                  {paymentAllocs.map(a => (
                    <div key={a.bill_voucher_id} className={styles.allocRow}>
                      <span className={styles.allocVno}>{a.bill_voucher_number}</span>
                      <span className={styles.allocDate}>{fmtDate(a.bill_voucher_date)}</span>
                      <span className={styles.allocAmt}>{formatIndianCurrency(a.amount_allocated)}</span>
                      <span className={styles.allocOf}>of {formatIndianCurrency(a.bill_amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

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

            {/* Supporting document upload — available on any submitted voucher */}
            {row && row.status !== 'draft' && row.status !== 'cancelled' && canUploadReceipt && (
              <div className={styles.receiptUploadBox}>
                <div className={styles.receiptUploadText}>
                  Attach supporting documents (invoices, bills, approvals).
                </div>
                <input
                  ref={docInputRef}
                  type="file"
                  multiple
                  accept="image/*,application/pdf"
                  className={styles.hiddenFileInput}
                  onChange={(e) => void handleUploadDocFiles(e.target.files)}
                />
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => docInputRef.current?.click()}
                  disabled={uploadingDoc}
                >
                  {uploadingDoc ? <Loader2 size={13} className={styles.spin} /> : <Paperclip size={13} />}
                  Attach Supporting Document
                </button>
              </div>
            )}

            {row?.status === 'completed' && canUploadReceipt && (
              <div className={styles.receiptUploadBox}>
                <div className={styles.receiptUploadText}>
                  Upload Transaction Receipts here.
                  <span className={styles.receiptUploadSub}>
                    Payments are made only after successful voucher completion.
                  </span>
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
                    <div className={styles.attachMeta}>
                      <span className={styles.attachName}>{att.file_name}</span>
                      <span className={styles.attachSize}>{formatFileSize(att.file_size)}</span>
                      {att.attachment_type === 'transfer_receipt' && (
                        <span className={styles.attachTypeBadge}>Receipt</span>
                      )}
                      <span className={styles.attachLinkHint}>Open attachment ↗</span>
                    </div>
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

              {/* Payment Confirmation — approved, completed, awaiting_payment ──── */}
              {(row.status === 'approved' || row.status === 'completed' || row.status === 'awaiting_payment') && (
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
                      WhatsApp opens automatically after uploading a transfer receipt, or click below to send manually.
                    </span>
                  </div>
                  <WaPaymentBtn
                    mobile={detail.entity_mobile ?? null}
                    name={detail.entity_name ?? null}
                    amount={detail.amount}
                    voucherNo={row.voucher_number}
                    companyCode={companyCode}
                  />

                  {/* Queue / Dequeue — role-gated; does NOT require payment_mode */}
                  {(row.status === 'completed' || row.status === 'awaiting_payment') &&
                    detail.payment_mode !== 'Cash' &&
                    (isSuperAdmin || role === 'admin' || role === 'accounts') && (
                    <div style={{ marginTop: '0.75rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                      {row.status === 'completed' && (
                        <button
                          type="button"
                          className={styles.btnSecondary}
                          onClick={() => { void handleQueueForPayment() }}
                          disabled={queueing}
                        >
                          {queueing ? <Loader2 size={13} className={styles.spin} /> : <Clock size={13} />}
                          Queue for Payment
                        </button>
                      )}
                      {row.status === 'awaiting_payment' && (
                        <button
                          type="button"
                          className={styles.btnSecondary}
                          onClick={() => { void handleDequeue() }}
                          disabled={queueing}
                        >
                          {queueing ? <Loader2 size={13} className={styles.spin} /> : <RotateCcw size={13} />}
                          Dequeue
                        </button>
                      )}
                      {/* Set Payment Mode — shown when queued but payment_mode not yet set */}
                      {row.status === 'awaiting_payment' && !detail.payment_mode &&
                        (isSuperAdmin || role === 'admin' || role === 'accounts') && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
                          <select
                            className={styles.select}
                            value={pendingMode}
                            onChange={e => setPendingMode(e.target.value)}
                            style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem', height: 'auto' }}
                            aria-label="Set payment mode"
                          >
                            <option value="">Set Payment Mode…</option>
                            {['Cash', 'Bank', 'UPI', 'Cheque', 'NEFT', 'RTGS', 'IMPS'].map(m => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className={styles.btnSecondary}
                            onClick={() => { void handleSetPaymentMode() }}
                            disabled={!pendingMode || settingMode}
                            style={{ fontSize: '0.75rem' }}
                          >
                            {settingMode ? <Loader2 size={13} className={styles.spin} /> : null}
                            Confirm
                          </button>
                        </div>
                      )}
                      {/* Pay Now — only when payment_mode is known */}
                      {canSeePayNow(role, isSuperAdmin, detail.payment_mode) && (
                        <button
                          type="button"
                          className={styles.btnPrimary}
                          onClick={() => onPayNow({
                            id:                  row.id,
                            voucher_number:      row.voucher_number,
                            amount:              row.amount,
                            payment_mode:        detail.payment_mode,
                            entity_name:         detail.entity_name,
                            entity_upi_id:       detail.entity_upi_id,
                            entity_bank_account: detail.entity_bank_account,
                            entity_bank_ifsc:    detail.entity_bank_ifsc,
                            entity_bank_name:    detail.entity_bank_name,
                            paid_from_account:   detail.paid_from_account,
                            paid_at:             detail.paid_at,
                            utr_number:          detail.utr_number,
                            cheque_number:       detail.cheque_number,
                          })}
                          style={{ gap: '0.375rem' }}
                        >
                          <CreditCard size={13} /> Pay Now
                        </button>
                      )}
                      {detail.paid_at && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--success)' }}>
                          ✓ Paid on {new Date(detail.paid_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Posted — paid summary ───────────────────────────────────── */}
              {row.status === 'posted' && (
                <div className={styles.panelSection} style={{ borderTop: '1px solid var(--border)', marginTop: '0.25rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.375rem 0' }}>
                    <span style={{ fontSize: '0.875rem', color: 'var(--success)', fontWeight: 600 }}>
                      ✓ Paid
                      {detail.paid_at && ` on ${new Date(detail.paid_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`}
                    </span>
                    {detail.paid_from_account && (
                      <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                        — from {detail.paid_from_account}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    onClick={handlePrintVoucherCopy}
                    style={{ marginTop: '0.375rem' }}
                  >
                    <FileText size={13} /> Voucher Copy
                  </button>
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
                        void onReloadPanel(row.id)
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
    </div>
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
  const isSuperAdmin = user?.profile.is_super_admin ?? false

  // Redirect viewer
  useEffect(() => {
    if (role === 'viewer') navigate('/', { replace: true })
  }, [role, navigate])

  // ── Filters ─────────────────────────────────────────────────────────────
  const [filters,     setFilters]     = useState<RegisterFilters>(defaultFilters)
  const [searchInput, setSearchInput] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [statusDropOpen, setStatusDropOpen] = useState(false)
  const [natureDropOpen, setNatureDropOpen] = useState(false)
  const statusDropRef = useRef<HTMLDivElement>(null)
  const natureDropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!statusDropOpen) return
    function onOutside(e: MouseEvent) {
      if (statusDropRef.current && !statusDropRef.current.contains(e.target as Node))
        setStatusDropOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [statusDropOpen])

  useEffect(() => {
    if (!natureDropOpen) return
    function onOutside(e: MouseEvent) {
      if (natureDropRef.current && !natureDropRef.current.contains(e.target as Node))
        setNatureDropOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [natureDropOpen])

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

  // ── Pay Now ───────────────────────────────────────────────────────────────
  const [payNowVoucher, setPayNowVoucher] = useState<PayNowVoucher | null>(null)

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
              style={{ background: 'var(--surface)', border: '1px solid var(--border-2)', color: 'var(--text)' }}
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

        {/* Workflow status dropdown */}
        <div className={styles.filterDrop} ref={statusDropRef}>
          <button
            className={`${styles.filterDropTrigger} ${filters.status ? styles.filterDropTriggerActive : ''}`}
            onClick={() => setStatusDropOpen(o => !o)}
          >
            <span className={styles.filterDropLabel}>Voucher Register</span>
            <span className={styles.filterDropValue}>
              {STATUS_PILLS.find(p => p.value === filters.status)?.label ?? 'All Vouchers'}
            </span>
            <ChevronDown size={12} className={`${styles.filterDropChevron} ${statusDropOpen ? styles.filterDropChevronOpen : ''}`} />
          </button>
          {statusDropOpen && (
            <div className={styles.filterDropMenu}>
              {STATUS_PILLS.map(p => (
                <button
                  key={p.value}
                  className={`${styles.filterDropItem} ${filters.status === p.value ? styles.filterDropItemActive : ''}`}
                  onClick={() => { setFilter('status', p.value); setStatusDropOpen(false) }}
                >
                  {p.label === 'All' ? 'All Vouchers' : p.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Voucher type dropdown */}
        <div className={styles.filterDrop} ref={natureDropRef}>
          <button
            className={`${styles.filterDropTrigger} ${filters.nature ? styles.filterDropTriggerActive : ''}`}
            onClick={() => setNatureDropOpen(o => !o)}
          >
            <span className={styles.filterDropLabel}>Voucher Type</span>
            <span className={styles.filterDropValue}>
              {filters.nature
                ? <><span className={styles.filterDropDot} style={{ background: NATURE_COLOR[filters.nature] }} />{NATURE_PILLS.find(p => p.value === filters.nature)?.label}</>  
                : 'All Types'
              }
            </span>
            <ChevronDown size={12} className={`${styles.filterDropChevron} ${natureDropOpen ? styles.filterDropChevronOpen : ''}`} />
          </button>
          {natureDropOpen && (
            <div className={styles.filterDropMenu}>
              {NATURE_PILLS.map(p => {
                const color = p.value ? NATURE_COLOR[p.value] : undefined
                return (
                  <button
                    key={p.value}
                    className={`${styles.filterDropItem} ${filters.nature === p.value ? styles.filterDropItemActive : ''}`}
                    onClick={() => { setFilter('nature', p.value); setNatureDropOpen(false) }}
                  >
                    {color
                      ? <span className={styles.filterDropDot} style={{ background: color }} />
                      : <span className={styles.filterDropDotEmpty} />
                    }
                    {p.label === 'All' ? 'All Types' : p.label}
                  </button>
                )
              })}
            </div>
          )}
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

      {/* ── Main: table ─────────────────────────────────────────────────── */}
      <div className={styles.main}>

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

        {/* Detail modal */}
        <DetailPanel
          row={selectedRow}
          detail={detail}
          loading={panelLoading}
          attachments={attachments}
          companyId={companyId}
          companyCode={companyCode}
          companyName={user?.activeCompany?.name ?? ''}
          userId={userId}
          role={role}
          isSuperAdmin={isSuperAdmin}
          onClose={closePanel}
          onRefresh={handleRefresh}
          onReloadPanel={loadPanelData}
          onPayNow={setPayNowVoucher}
        />

      </div>

      {/* Pay Now Modal */}
      {payNowVoucher && (
        <PayNowModal
          voucher={payNowVoucher}
          companyId={companyId}
          userId={userId}
          onPaid={() => {
            handleRefresh()
            if (selectedId) void loadPanelData(selectedId)
          }}
          onClose={() => setPayNowVoucher(null)}
        />
      )}
    </div>
  )
}
