/**
 * PayNowModal — Pay Now workflow for completed vouchers.
 *
 * Desktop (> 768px):
 *   UPI          → QR code (api.qrserver.com, 220×220) + UPI ID
 *   Account Tfr  → Bank details card with per-field copy + Copy All + net banking URL
 *
 * Mobile (Mobi|Android in userAgent):
 *   UPI          → [Open in GPay] + [Any UPI App] with visibilitychange → auto-open Mark Paid
 *   Account Tfr  → Bank details card + Copy All + bank app launcher (from paid_from_account)
 *
 * Mark Paid panel:
 *   paid_from_account (required for Account Transfer) — datalist from company_payment_accounts
 *   paid_at (default today)
 *   utr_number with [📋 Paste]
 *   [Mark as Paid] submit
 */
import { useState, useEffect, useCallback } from 'react'
import { X, Check, Loader2, AlertCircle, Copy, CheckCheck } from 'lucide-react'
import { toast } from 'sonner'
import { formatIndianCurrency } from '@/lib/vouchers'
import {
  fetchCompanyPaymentAccounts,
  markVoucherPaid,
  type CompanyPaymentAccount,
} from '@/lib/pay-now'
import styles from './PayNowModal.module.css'

// ── Constants ─────────────────────────────────────────────────────────────────

const NET_BANKING_URLS: Record<string, string> = {
  'federal bank': 'https://www.fednetbank.com',
  'hdfc bank':    'https://netbanking.hdfcbank.com',
  'hdfc':         'https://netbanking.hdfcbank.com',
  'canara bank':  'https://canarabank.com/User/logon.aspx',
  'sbi':          'https://retail.sbi.co.in',
  'axis bank':    'https://retail.axisbank.co.in',
}

const BANK_APPS: Record<string, string> = {
  'federal bank': 'com.corporatefedmobile',
  'hdfc bank':    'com.hdfc.cbx',
  'hdfc':         'com.hdfc.cbx',
  'canara bank':  'com.symbiosis.canmobile',
}

// Bank transfer modes in Pramaana (= "Account Transfer" in spec)
const BANK_TRANSFER_MODES = new Set(['Bank', 'Cheque', 'NEFT', 'RTGS', 'IMPS'])

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMobile(): boolean {
  return /Mobi|Android/i.test(navigator.userAgent)
}

function isIOS(): boolean {
  return /iPhone|iPad/i.test(navigator.userAgent)
}

function buildUpiUrl(upiId: string, payeeName: string, amount: number, voucherNo: string): string {
  const params = new URLSearchParams({
    pa: upiId,
    pn: payeeName,
    am: amount.toFixed(2),
    cu: 'INR',
    tn: `Voucher ${voucherNo}`,
  })
  return `upi://pay?${params.toString()}`
}

function buildGpayUrl(upiId: string, payeeName: string, amount: number, voucherNo: string): string {
  const tn = encodeURIComponent(`Voucher ${voucherNo}`)
  if (isIOS()) {
    return `gpay://upi/pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${amount.toFixed(2)}&cu=INR&tn=${tn}`
  }
  // Android intent
  return (
    `intent://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}` +
    `&am=${amount.toFixed(2)}&cu=INR&tn=${tn}` +
    `#Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;end`
  )
}

function getNetBankingUrl(bankName: string | null): { url: string; label: string } | null {
  if (!bankName) return null
  const key = bankName.toLowerCase()
  for (const [k, url] of Object.entries(NET_BANKING_URLS)) {
    if (key.includes(k) || k.includes(key)) return { url, label: bankName }
  }
  return null
}

function getBankAppPackage(paidFrom: string | null): { pkg: string; label: string } | null {
  if (!paidFrom) return null
  const key = paidFrom.toLowerCase()
  for (const [k, pkg] of Object.entries(BANK_APPS)) {
    if (key.includes(k)) {
      const label = k.replace(/(^|\s)\S/g, c => c.toUpperCase())
      return { pkg, label }
    }
  }
  return null
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function nowTimestamp(): string {
  return new Date().toISOString()
}

async function copyToClipboard(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label} copied`)
  } catch {
    toast.error('Copy failed — check clipboard permissions')
  }
}

// ── Prop types ────────────────────────────────────────────────────────────────

export interface PayNowVoucher {
  id:                  string
  voucher_number:      string
  amount:              number
  payment_mode:        string | null
  entity_name:         string | null
  entity_upi_id:       string | null
  entity_bank_account: string | null
  entity_bank_ifsc:    string | null
  entity_bank_name:    string | null
  paid_from_account:   string | null   // already-set value (if any)
  paid_at:             string | null   // already-set value (if any)
  utr_number:          string | null
}

interface Props {
  voucher:   PayNowVoucher
  companyId: string
  onPaid:    () => void
  onClose:   () => void
}

// ── CopyFieldBtn ──────────────────────────────────────────────────────────────

function CopyFieldBtn({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    await copyToClipboard(value, label)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      type="button"
      className={`${styles.bankCopyBtn} ${copied ? styles.bankCopyBtnCopied : ''}`}
      onClick={handleCopy}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
    >
      {copied ? <CheckCheck size={12} /> : <Copy size={12} />}
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PayNowModal({ voucher, companyId, onPaid, onClose }: Props) {
  const mobile  = isMobile()
  const mode    = voucher.payment_mode ?? ''
  const isUpi   = mode === 'UPI'
  const isBank  = BANK_TRANSFER_MODES.has(mode)

  // Payment accounts for datalist
  const [payAccounts, setPayAccounts] = useState<CompanyPaymentAccount[]>([])
  useEffect(() => {
    fetchCompanyPaymentAccounts(companyId).then(setPayAccounts).catch(() => {})
  }, [companyId])

  // Mark Paid panel state
  const alreadyPaid = !!voucher.paid_at
  const [markPaidOpen, setMarkPaidOpen] = useState(false)
  const [paidFrom,     setPaidFrom]     = useState(voucher.paid_from_account ?? '')
  const [paidAt,       setPaidAt]       = useState(todayIso())
  const [utr,          setUtr]          = useState(voucher.utr_number ?? '')
  const [submitting,   setSubmitting]   = useState(false)
  const [fromError,    setFromError]    = useState(false)

  // visibilitychange listener — auto-open Mark Paid after returning from UPI app
  const openMarkPaid = useCallback(() => {
    setMarkPaidOpen(true)
  }, [])

  const attachVisibilityListener = useCallback(() => {
    function handler() {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', handler)
        openMarkPaid()
      }
    }
    document.addEventListener('visibilitychange', handler)
  }, [openMarkPaid])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // ── UPI data ──────────────────────────────────────────────────────────────
  const upiUrl  = (voucher.entity_upi_id && voucher.entity_name)
    ? buildUpiUrl(voucher.entity_upi_id, voucher.entity_name, voucher.amount, voucher.voucher_number)
    : null
  const qrUrl   = upiUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(upiUrl)}&bgcolor=ffffff&color=1a1a1a&margin=10`
    : null
  const gpayUrl = (voucher.entity_upi_id && voucher.entity_name)
    ? buildGpayUrl(voucher.entity_upi_id, voucher.entity_name, voucher.amount, voucher.voucher_number)
    : null
  const anyUpiUrl = upiUrl

  // ── Bank data ─────────────────────────────────────────────────────────────
  const netBanking = getNetBankingUrl(voucher.entity_bank_name)
  const bankApp    = mobile ? getBankAppPackage(paidFrom || voucher.paid_from_account) : null

  // Build "Copy All Details" text
  const buildCopyAllText = () => [
    `Payee: ${voucher.entity_name ?? '—'}`,
    `Account No: ${voucher.entity_bank_account ?? '—'}`,
    `IFSC: ${voucher.entity_bank_ifsc ?? '—'}`,
    `Bank: ${voucher.entity_bank_name ?? '—'}`,
    `Amount: ${formatIndianCurrency(voucher.amount)}`,
    `Reference: ${voucher.voucher_number}`,
  ].join('\n')

  // ── Mark Paid submit ──────────────────────────────────────────────────────
  const handleMarkPaid = async () => {
    if (isBank && !paidFrom.trim()) {
      setFromError(true)
      return
    }
    setSubmitting(true)
    try {
      await markVoucherPaid(voucher.id, {
        paid_from_account: paidFrom.trim() || null,
        paid_at:           paidAt ? new Date(paidAt).toISOString() : nowTimestamp(),
        utr_number:        utr.trim() || null,
      })
      toast.success('Voucher marked as paid')
      onPaid()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to mark as paid')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Bank app launcher ─────────────────────────────────────────────────────
  const handleBankApp = () => {
    if (!bankApp) return
    const intentUrl = `intent://#${bankApp.pkg}?#Intent;scheme=android-app;end`
    const a = document.createElement('a')
    a.href = intentUrl
    a.click()
    setTimeout(() => {
      toast('Could not open bank app — open it manually.', { duration: 3500 })
    }, 1800)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div className={styles.modal} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className={styles.header}>
          <span className={styles.title}>💳 Pay Now — {voucher.voucher_number}</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className={styles.body}>

          {/* Summary card */}
          <div className={styles.summaryCard}>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Payee</span>
              <span className={styles.summaryValue}>{voucher.entity_name ?? '—'}</span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Amount</span>
              <span className={`${styles.summaryValue} ${styles.summaryAmount}`}>
                {formatIndianCurrency(voucher.amount)}
              </span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Mode</span>
              <span className={styles.summaryValue}>{mode || '—'}</span>
            </div>
            {voucher.paid_from_account && (
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Paid From</span>
                <span className={styles.summaryValue}>{voucher.paid_from_account}</span>
              </div>
            )}
          </div>

          {/* ── UPI section ──────────────────────────────────────────────── */}
          {isUpi && (
            <div className={styles.section}>
              <span className={styles.sectionTitle}>
                {mobile ? 'Open UPI App' : 'Scan to Pay'}
              </span>

              {!voucher.entity_upi_id ? (
                <div className={styles.noUpiWarn}>
                  <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>No UPI ID recorded for this payee. Edit the payee to add their UPI ID.</span>
                </div>
              ) : mobile ? (
                /* Mobile UPI buttons */
                <div className={styles.upiButtons}>
                  <a
                    href={gpayUrl ?? '#'}
                    className={styles.btnGpay}
                    onClick={() => { if (gpayUrl) attachVisibilityListener() }}
                  >
                    Open in GPay
                  </a>
                  <a
                    href={anyUpiUrl ?? '#'}
                    className={styles.btnUpiAny}
                    onClick={() => { if (anyUpiUrl) attachVisibilityListener() }}
                  >
                    Any UPI App
                  </a>
                  <div className={styles.upiId}>UPI: {voucher.entity_upi_id}</div>
                </div>
              ) : (
                /* Desktop QR */
                <div className={styles.qrWrap}>
                  {qrUrl && (
                    <img
                      src={qrUrl}
                      alt="UPI QR Code"
                      className={styles.qrImg}
                      width={220}
                      height={220}
                    />
                  )}
                  <div className={styles.upiId}>UPI: {voucher.entity_upi_id}</div>
                </div>
              )}
            </div>
          )}

          {/* ── Account Transfer section ──────────────────────────────────── */}
          {isBank && (
            <div className={styles.section}>
              <span className={styles.sectionTitle}>Bank Transfer Details</span>

              <div className={styles.bankCard}>
                {[
                  { label: 'Payee',      value: voucher.entity_name      ?? '—' },
                  { label: 'Account No', value: voucher.entity_bank_account ?? '—' },
                  { label: 'IFSC',       value: voucher.entity_bank_ifsc  ?? '—' },
                  { label: 'Bank',       value: voucher.entity_bank_name  ?? '—' },
                  { label: 'Reference',  value: voucher.voucher_number },
                ].map(({ label, value }) => (
                  <div className={styles.bankRow} key={label}>
                    <span className={styles.bankLabel}>{label}</span>
                    <span className={styles.bankValue}>{value}</span>
                    <CopyFieldBtn value={value} label={label} />
                  </div>
                ))}
                <div className={styles.bankRow}>
                  <span className={styles.bankLabel}>Amount</span>
                  <span className={`${styles.bankValue} ${styles.bankValueAmount}`}>
                    {formatIndianCurrency(voucher.amount)}
                  </span>
                  <CopyFieldBtn value={voucher.amount.toFixed(2)} label="Amount" />
                </div>
              </div>

              <div className={styles.actionButtons}>
                {/* Copy All Details */}
                <button
                  type="button"
                  className={styles.btnCopyAll}
                  onClick={() => copyToClipboard(buildCopyAllText(), 'Bank details')}
                >
                  📋 Copy All Details
                </button>

                {/* Desktop: net banking URL */}
                {!mobile && netBanking && (
                  <a
                    href={netBanking.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.btnNetBanking}
                  >
                    🌐 Open {netBanking.label} Net Banking ↗
                  </a>
                )}

                {/* Mobile: bank app launcher (derived from paid_from_account input) */}
                {mobile && bankApp && (
                  <button
                    type="button"
                    className={styles.btnBankApp}
                    onClick={handleBankApp}
                  >
                    📱 Open {bankApp.label} App
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── Already paid badge ────────────────────────────────────────── */}
          {alreadyPaid ? (
            <div className={styles.alreadyPaidBadge}>
              <Check size={14} /> Marked as paid on{' '}
              {new Date(voucher.paid_at!).toLocaleDateString('en-IN', {
                day: '2-digit', month: 'short', year: 'numeric',
              })}
              {voucher.paid_from_account && ` — from ${voucher.paid_from_account}`}
            </div>
          ) : (
            /* ── Mark as Paid toggle button ─────────────────────────────── */
            !markPaidOpen && (
              <button
                type="button"
                className={styles.btnMarkPaidToggle}
                onClick={() => setMarkPaidOpen(true)}
              >
                ✓ Mark as Paid
              </button>
            )
          )}

          {/* ── Mark Paid panel ───────────────────────────────────────────── */}
          {markPaidOpen && !alreadyPaid && (
            <div className={styles.markPaidPanel}>
              <div className={styles.markPaidTitle}>Record Payment</div>

              {/* Paid From Account */}
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>
                  Paid From Account
                  {isBank && <span className={styles.fieldRequired}>*</span>}
                </label>
                <input
                  id="paidFromList"
                  list="paidFromAccounts"
                  className={`${styles.fieldInput} ${fromError ? styles.fieldError : ''}`}
                  placeholder="e.g. HDFC Current A/C"
                  value={paidFrom}
                  onChange={e => { setPaidFrom(e.target.value); setFromError(false) }}
                  autoComplete="off"
                />
                <datalist id="paidFromAccounts">
                  {payAccounts.map(a => (
                    <option key={a.id} value={a.label} />
                  ))}
                </datalist>
                {fromError && (
                  <span className={styles.validationError}>
                    <AlertCircle size={11} />
                    Please select which account this payment was sent from.
                  </span>
                )}
              </div>

              {/* Paid At */}
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Payment Date</label>
                <input
                  type="date"
                  className={styles.fieldInput}
                  value={paidAt}
                  max={todayIso()}
                  onChange={e => setPaidAt(e.target.value)}
                />
              </div>

              {/* UTR Number */}
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>UTR / Transaction Reference</label>
                <div className={styles.fieldWithBtn}>
                  <input
                    type="text"
                    className={styles.fieldInput}
                    placeholder="UTR / Ref number (optional)"
                    value={utr}
                    onChange={e => setUtr(e.target.value)}
                  />
                  <button
                    type="button"
                    className={styles.btnPaste}
                    onClick={() => navigator.clipboard.readText().then(t => setUtr(t)).catch(() => toast.error('Clipboard access denied'))}
                    title="Paste from clipboard"
                  >
                    📋 Paste
                  </button>
                </div>
              </div>

              {/* Submit */}
              <button
                type="button"
                className={styles.btnSubmitPaid}
                onClick={handleMarkPaid}
                disabled={submitting}
              >
                {submitting
                  ? <Loader2 size={14} className={styles.spin} />
                  : <Check size={14} />
                }
                Mark as Paid
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
