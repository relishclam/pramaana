import { useState } from 'react'
import { Check, X } from 'lucide-react'
import type { OpenBill, AllocRow } from '@/lib/allocations'
import { formatIndianCurrency } from '@/lib/vouchers'
import styles from './BillAllocPanel.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  bills:     OpenBill[]
  loading:   boolean
  onConfirm: (rows: AllocRow[], total: number) => void
  onSkip:    () => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BillAllocPanel({ bills, loading, onConfirm, onSkip }: Props) {
  // Map of bill_id → amount string (for selected bills only)
  const [selected, setSelected] = useState<Record<string, string>>({})

  const toggle = (bill: OpenBill) => {
    setSelected(prev => {
      if (prev[bill.id] !== undefined) {
        const next = { ...prev }
        delete next[bill.id]
        return next
      }
      return { ...prev, [bill.id]: bill.outstanding.toFixed(2) }
    })
  }

  const setAmount = (id: string, val: string) =>
    setSelected(prev => ({ ...prev, [id]: val }))

  const selectedRows: AllocRow[] = Object.entries(selected)
    .map(([id, amt]) => ({ bill_voucher_id: id, amount_allocated: parseFloat(amt) || 0 }))
    .filter(r => r.amount_allocated > 0)

  const total = selectedRows.reduce((s, r) => s + r.amount_allocated, 0)

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className={styles.loadingBox}>
        <span className={styles.loadDot} />
        <span className={styles.loadText}>Checking open bills…</span>
      </div>
    )
  }

  // ── No open bills ─────────────────────────────────────────────────────────

  if (!bills.length) {
    return (
      <div className={styles.noBillsBox}>
        <div className={styles.noBillsTitle}>No outstanding bills found</div>
        <div className={styles.noBillsSub}>
          This will be recorded as an advance / unallocated payment.
        </div>
        <button type="button" className={styles.confirmBtn} onClick={onSkip}>
          Continue
        </button>
      </div>
    )
  }

  // ── Bill list ─────────────────────────────────────────────────────────────

  return (
    <div className={styles.panel}>
      <div className={styles.billList}>
        {bills.map(bill => {
          const isSelected = selected[bill.id] !== undefined
          const allocAmt   = selected[bill.id] ?? ''
          return (
            <div
              key={bill.id}
              className={`${styles.billRow} ${isSelected ? styles.billRowSelected : ''}`}
            >
              <button
                type="button"
                className={`${styles.checkBtn} ${isSelected ? styles.checkBtnActive : ''}`}
                onClick={() => toggle(bill)}
                aria-label={isSelected ? 'Deselect bill' : 'Select bill'}
              >
                {isSelected ? <Check size={11} /> : null}
              </button>

              <div className={styles.billInfo}>
                <span className={styles.billNo}>{bill.voucher_number}</span>
                {bill.ref_document_number && (
                  <span className={styles.billRef}>{bill.ref_document_number}</span>
                )}
                <span className={styles.billDate}>{fmtDate(bill.voucher_date)}</span>
              </div>

              <div className={styles.billAmts}>
                <span className={styles.billOriginal}>{formatIndianCurrency(bill.amount)}</span>
                <span className={styles.billOutstanding}>
                  {formatIndianCurrency(bill.outstanding)} due
                </span>
              </div>

              {isSelected && (
                <div className={styles.allocInput}>
                  <span className={styles.rupee}>₹</span>
                  <input
                    className={styles.allocAmtInput}
                    type="number"
                    min="0.01"
                    max={bill.outstanding}
                    step="0.01"
                    value={allocAmt}
                    onChange={e => setAmount(bill.id, e.target.value)}
                    onClick={e => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    type="button"
                    className={styles.clearAllocBtn}
                    onClick={() => toggle(bill)}
                    aria-label="Remove bill"
                  >
                    <X size={11} />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {selectedRows.length > 0 && (
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>Total to pay</span>
          <span className={styles.totalAmt}>{formatIndianCurrency(total)}</span>
        </div>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.confirmBtn}
          onClick={() => selectedRows.length > 0 && onConfirm(selectedRows, total)}
          disabled={selectedRows.length === 0}
        >
          <Check size={14} /> Confirm &amp; Set Amount
        </button>
        <button type="button" className={styles.skipBtn} onClick={onSkip}>
          Skip — advance / no allocation
        </button>
      </div>
    </div>
  )
}
