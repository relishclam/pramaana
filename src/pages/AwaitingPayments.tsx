/**
 * AwaitingPayments — /payments route
 *
 * Shows all completed, non-Cash vouchers that have not yet been marked paid
 * (paid_at IS NULL), sorted by completed_at ASC (oldest first).
 *
 * Vouchers where completed_at < now() - 48 hours are flagged ⚠ Pending 2+ days.
 */
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import FoodStreamMini from '@/components/FoodStreamMini'
import { Loader2, Clock, AlertTriangle, CreditCard, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import { formatIndianCurrency } from '@/lib/vouchers'
import { fetchAwaitingPayments, fetchAdminMobile, dequeuePayment, type AwaitingPaymentRow } from '@/lib/pay-now'
import { fetchVoucherFull } from '@/lib/approvals'
import PayNowModal, { type PayNowVoucher } from '@/components/PayNowModal'
import styles from './VoucherRegister.module.css'   // reuse existing styles

// ── Constants ─────────────────────────────────────────────────────────────────

const BANK_TRANSFER_MODES = new Set(['bank', 'cheque', 'neft', 'rtgs', 'imps'])
const OVERDUE_MS = 48 * 60 * 60 * 1000   // 48 hours

// ── Helpers ───────────────────────────────────────────────────────────────────

function isOverdue(queuedAt: string | null): boolean {
  if (!queuedAt) return false
  return Date.now() - new Date(queuedAt).getTime() > OVERDUE_MS
}

function formatPaymentMode(mode: string | null): string {
  if (!mode) return '—'
  const MAP: Record<string, string> = {
    upi:    'UPI',
    bank:   'Bank Transfer',
    neft:   'NEFT',
    rtgs:   'RTGS',
    imps:   'IMPS',
    cheque: 'Cheque',
    cash:   'Cash',
  }
  return MAP[mode.toLowerCase()] ?? mode
}

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function canSeePayNow(role: string | null, isSuperAdmin: boolean, paymentMode: string | null): boolean {
  if (!paymentMode || paymentMode.toLowerCase() === 'cash') return false
  if (isSuperAdmin || role === 'admin') return true
  if (role === 'accounts' && BANK_TRANSFER_MODES.has(paymentMode.toLowerCase())) return true
  return false
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AwaitingPayments() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const companyId    = user?.activeCompany?.id  ?? ''
  const role         = user?.activeRole         ?? null
  const isSuperAdmin = user?.profile.is_super_admin ?? false
  const userId       = user?.id ?? ''

  const [rows,    setRows]    = useState<AwaitingPaymentRow[]>([])
  const [loading, setLoading] = useState(false)
  const [payNowVoucher, setPayNowVoucher] = useState<PayNowVoucher | null>(null)
  const [resolving,  setResolving]  = useState<string | null>(null)   // voucherId being Pay-Now resolved
  const [dequeuing,  setDequeuing]  = useState<string | null>(null)   // voucherId being dequeued
  const [sendingWa, setSendingWa] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      setRows(await fetchAwaitingPayments(companyId))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [companyId])

  useEffect(() => { void load() }, [load])

  // Redirect users who can't see any pay-now vouchers
  useEffect(() => {
    if (role === 'viewer' || role === 'auditor') navigate('/', { replace: true })
  }, [role, navigate])

  const openPayNow = async (row: AwaitingPaymentRow) => {
    setResolving(row.id)
    try {
      const detail = await fetchVoucherFull(row.id)
      setPayNowVoucher({
        id:                  row.id,
        voucher_number:      row.voucher_number,
        amount:              row.amount,
        payment_mode:        row.payment_mode,
        entity_id:           row.entity_id ?? null,
        entity_name:         detail.entity_name ?? row.entity_name,
        entity_upi_id:       detail.entity_upi_id,
        entity_bank_account: detail.entity_bank_account,
        entity_bank_ifsc:    detail.entity_bank_ifsc,
        entity_bank_name:    detail.entity_bank_name,
        paid_from_account:   detail.paid_from_account,
        paid_at:             detail.paid_at,
        utr_number:          detail.utr_number,
        cheque_number:       detail.cheque_number,
      })
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load voucher')
    } finally {
      setResolving(null)
    }
  }

  // ── Dequeue (return to OTP Verified) ────────────────────────────────────
  const handleDequeue = async (voucherId: string) => {
    setDequeuing(voucherId)
    try {
      await dequeuePayment(voucherId)
      toast.success('Voucher removed from payment queue')
      void load()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to dequeue voucher')
    } finally {
      setDequeuing(null)
    }
  }

  // ── WhatsApp "Send to Admin" ─────────────────────────────────────────────
  const handleSendToAdmin = async () => {
    if (!rows.length) return
    setSendingWa(true)
    try {
      const mobile = await fetchAdminMobile(companyId)
      if (!mobile) {
        toast.error('Admin mobile number not set. Add it in Master Data → Users.')
        return
      }

      const lines = rows.map((v, i) =>
        `${i + 1}. ${v.entity_name ?? 'Unknown payee'} — ` +
        `₹${v.amount.toLocaleString('en-IN')} (${v.voucher_number})`
      ).join('\n')
      const total = rows.reduce((sum, v) => sum + v.amount, 0)
      const message =
        `Pramaana — Payments Awaiting Approval\n\n` +
        `${lines}\n\n` +
        `Total: ₹${total.toLocaleString('en-IN')} ` +
        `(${rows.length} payment${rows.length === 1 ? '' : 's'})\n\n` +
        `Open Pramaana to pay:\nhttps://pramaana-tau.vercel.app/payments`

      // Normalise to E.164 without '+': 10 digits → prepend '91', else use digits as-is
      const digits = mobile.replace(/\D/g, '')
      const wa     = digits.length === 10 ? `91${digits}` : digits

      window.open(`https://wa.me/${wa}?text=${encodeURIComponent(message)}`, '_blank')
      toast.success('✓ WhatsApp opened — send the message to notify Admin.')
    } finally {
      setSendingWa(false)
    }
  }

  return (
    <div className={styles.page}>

      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Awaiting Payment</h1>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '0.125rem' }}>
            Vouchers queued for payment · sorted oldest first
          </p>
        </div>
      </div>

      {/* Summary bar — outside styles.main so it spans full width above the table */}
      {rows.length > 0 && (
        <div style={{ padding: '0 1.5rem 0.75rem' }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0.625rem 1rem',
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: '8px', gap: '1rem', flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
              <strong style={{ color: 'var(--text)' }}>{rows.length} payment{rows.length !== 1 ? 's' : ''}</strong>{' '}
              waiting &middot; Total{' '}
              <strong style={{ color: 'var(--gold)' }}>
                {formatIndianCurrency(rows.reduce((s, r) => s + r.amount, 0))}
              </strong>
            </span>
            <button
              onClick={() => { void handleSendToAdmin() }}
              disabled={sendingWa}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
                padding: '0.375rem 0.875rem', fontSize: '0.8125rem', fontWeight: 600,
                background: '#25d366', color: '#fff', border: 'none',
                borderRadius: '6px', cursor: sendingWa ? 'not-allowed' : 'pointer',
                opacity: sendingWa ? 0.7 : 1,
              }}
            >
              &#128228; Send to Admin via WhatsApp
            </button>
          </div>
        </div>
      )}

      <div className={styles.main}>
        <div className={styles.tableWrap}>
          {loading ? (
            <div className={styles.centerState}>
              <FoodStreamMini label="" />
            </div>
          ) : rows.length === 0 ? (
            <div className={styles.emptyState}>
              <CreditCard size={44} className={styles.emptyIcon} />
              <p className={styles.emptyTitle}>No payments queued</p>
              <p className={styles.emptySub}>Accounts queues OTP-verified vouchers here before marking as paid.</p>
            </div>
          ) : (
          <table className={styles.table}>
              <thead>
                <tr className={styles.headerRow}>
                  <th>Voucher No.</th>
                  <th>Party</th>
                  <th>Mode</th>
                  <th className={styles.right}>Amount</th>
                  <th>Queued</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const overdue  = isOverdue(row.queued_at)
                  const canPay   = canSeePayNow(role, isSuperAdmin, row.payment_mode)
                  return (
                    <tr key={row.id} className={styles.row}>
                      <td className={styles.voucherNo}>
                        <div>{row.voucher_number}</div>
                        {overdue && (
                          <div style={{
                            display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                            marginTop: '0.2rem', fontSize: '0.6875rem', fontWeight: 600,
                            color: '#f59e0b', background: 'rgba(245,158,11,0.12)',
                            border: '1px solid rgba(245,158,11,0.3)',
                            borderRadius: '4px', padding: '1px 5px',
                          }}>
                            <AlertTriangle size={10} /> Pending 2+ days
                          </div>
                        )}
                      </td>
                      <td className={styles.partyCell}>{row.entity_name ?? <span className={styles.dim}>—</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span style={{
                          fontSize: '0.75rem', padding: '2px 7px',
                          background: 'var(--surface-2)', border: '1px solid var(--border)',
                          borderRadius: '4px', color: 'var(--text-muted)',
                        }}>
                          {formatPaymentMode(row.payment_mode)}
                        </span>
                      </td>
                      <td className={`${styles.amountCell} ${styles.right}`} style={{ whiteSpace: 'nowrap' }}>
                        {formatIndianCurrency(row.amount)}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                          <Clock size={12} />
                          {row.queued_at ? fmtDate(row.queued_at.slice(0, 10)) : '—'}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                          <button
                            className={styles.btnSecondary}
                            style={{ padding: '0.3125rem 0.75rem', fontSize: '0.8125rem' }}
                            onClick={() => { void handleDequeue(row.id) }}
                            disabled={dequeuing === row.id || resolving === row.id}
                          >
                            {dequeuing === row.id
                              ? <Loader2 size={12} className={styles.spin} />
                              : <RotateCcw size={12} />
                            }
                            Dequeue
                          </button>
                          {canPay && (
                            <button
                              className={styles.btnPrimary}
                              style={{ padding: '0.3125rem 0.75rem', fontSize: '0.8125rem' }}
                              onClick={() => openPayNow(row)}
                              disabled={resolving === row.id || dequeuing === row.id}
                            >
                              {resolving === row.id
                                ? <Loader2 size={12} className={styles.spin} />
                                : <CreditCard size={12} />
                              }
                              Pay Now
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {payNowVoucher && (
        <PayNowModal
          voucher={payNowVoucher}
          companyId={companyId}
          userId={userId}
          onPaid={() => { void load() }}
          onClose={() => setPayNowVoucher(null)}
        />
      )}
    </div>
  )
}
