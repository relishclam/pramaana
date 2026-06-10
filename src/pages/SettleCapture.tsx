/**
 * SettleCapture — public mobile page (no auth required).
 * Staff open this via the settlement link /settle/:token
 * to submit expense / refund entries against a suspense advance.
 */
import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { PlusCircle, Trash2, CheckCircle, AlertCircle, Loader2 } from 'lucide-react'
import {
  getSessionByToken,
  submitExpenseEntry,
  type PublicSession,
  type SubmitExpensePayload,
} from '@/lib/suspense'
import { formatIndianCurrency } from '@/lib/vouchers'
import styles from './SettleCapture.module.css'

// ── Row state ─────────────────────────────────────────────────────────────────

interface Row {
  id:               number
  entry_type:       'expense' | 'refund'
  description:      string
  amount:           string
  head_of_account:  string
  reference_number: string
  invoice_available: boolean
}

function blankRow(id: number): Row {
  return {
    id,
    entry_type:       'expense',
    description:      '',
    amount:           '',
    head_of_account:  '',
    reference_number: '',
    invoice_available: false,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type PageState = 'loading' | 'invalid' | 'expired' | 'closed' | 'form' | 'submitting' | 'done'

// ── Main component ────────────────────────────────────────────────────────────

export default function SettleCapture() {
  const { token } = useParams<{ token: string }>()

  const [pageState,  setPageState]  = useState<PageState>('loading')
  const [session,    setSession]    = useState<PublicSession | null>(null)
  const [rows,       setRows]       = useState<Row[]>([blankRow(1)])
  const [nextId,     setNextId]     = useState(2)
  const [errMsg,     setErrMsg]     = useState('')
  const formRef = useRef<HTMLDivElement>(null)

  // ── Load session ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!token) { setPageState('invalid'); return }
    getSessionByToken(token)
      .then(s => {
        if (!s) { setPageState('invalid'); return }
        if (s.voucher_status === 'rejected') { setPageState('closed'); return }
        if (s.session_status === 'expired')  { setPageState('expired'); return }
        if (s.voucher_status === 'closed')   { setPageState('closed'); return }
        setSession(s)
        setPageState('form')
      })
      .catch(() => setPageState('invalid'))
  }, [token])

  // ── Row mutations ───────────────────────────────────────────────────────────

  const addRow = () => {
    setRows(r => [...r, blankRow(nextId)])
    setNextId(n => n + 1)
    setTimeout(() => {
      formRef.current?.scrollTo({ top: formRef.current.scrollHeight, behavior: 'smooth' })
    }, 50)
  }

  const removeRow = (id: number) => {
    setRows(r => r.filter(x => x.id !== id))
  }

  const updateRow = (id: number, patch: Partial<Row>) => {
    setRows(r => r.map(x => x.id === id ? { ...x, ...patch } : x))
  }

  // ── Validation ──────────────────────────────────────────────────────────────

  const totalAmount = rows.reduce((sum, r) => {
    const n = parseFloat(r.amount)
    if (isNaN(n) || n <= 0) return sum
    return r.entry_type === 'refund' ? sum - n : sum + n
  }, 0)

  const balance = session ? (session.suspense_balance ?? session.voucher_amount) : 0

  const canSubmit = rows.length > 0 && rows.every(r => {
    const n = parseFloat(r.amount)
    return r.description.trim().length > 0 && !isNaN(n) && n > 0
  })

  // ── Submit ──────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!session || !canSubmit || pageState !== 'form') return
    setPageState('submitting')
    setErrMsg('')
    try {
      for (const row of rows) {
        const payload: SubmitExpensePayload = {
          advance_voucher_id: session.advance_voucher_id,
          session_id:         session.session_id,
          company_id:         session.company_id,
          entity_id:          session.entity_id,
          amount:             parseFloat(row.amount),
          entry_type:         row.entry_type,
          description:        row.description.trim(),
          head_of_account:    row.head_of_account.trim() || null,
          reference_number:   row.reference_number.trim() || null,
          invoice_available:  row.invoice_available,
        }
        await submitExpenseEntry(payload)
      }
      setPageState('done')
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : 'Submission failed')
      setPageState('form')
    }
  }

  const resetForAnother = () => {
    setRows([blankRow(1)])
    setNextId(2)
    setPageState('form')
    setErrMsg('')
    // Re-validate session balance is still open
    if (session && token) {
      getSessionByToken(token).then(s => {
        if (!s || s.voucher_status === 'closed') {
          setPageState('closed')
        } else {
          setSession(s)
        }
      })
    }
  }

  // ── Screens ─────────────────────────────────────────────────────────────────

  if (pageState === 'loading') {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.logo}>PRAMAANA</div>
          <Loader2 size={32} className={styles.spin} />
          <p className={styles.sub}>Loading…</p>
        </div>
      </div>
    )
  }

  if (pageState === 'invalid') {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.logo}>PRAMAANA</div>
          <AlertCircle size={36} className={styles.errorIcon} />
          <h2 className={styles.title}>Link is invalid</h2>
          <p className={styles.sub}>This link is not valid. Ask your accounts team for a new link.</p>
        </div>
      </div>
    )
  }

  if (pageState === 'expired') {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.logo}>PRAMAANA</div>
          <AlertCircle size={36} className={styles.warnIcon} />
          <h2 className={styles.title}>Link has expired</h2>
          <p className={styles.sub}>This settlement link has expired. Ask your accounts team to send a new link.</p>
        </div>
      </div>
    )
  }

  if (pageState === 'closed') {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.logo}>PRAMAANA</div>
          <CheckCircle size={36} className={styles.successIcon} />
          <h2 className={styles.title}>Advance fully settled</h2>
          <p className={styles.sub}>This advance has been fully accounted for. No further entries are needed.</p>
        </div>
      </div>
    )
  }

  if (pageState === 'done') {
    return (
      <div className={styles.page}>
        <div className={styles.doneCard}>
          <div className={styles.logo}>PRAMAANA</div>
          <CheckCircle size={42} className={styles.successIcon} />
          <h2 className={styles.title}>Submitted!</h2>
          <p className={styles.sub}>
            Your {rows.length === 1 ? 'entry has' : `${rows.length} entries have`} been submitted and
            are pending approval by the accounts team.
          </p>
          <button className={styles.secondaryBtn} onClick={resetForAnother}>
            Submit another entry
          </button>
        </div>
      </div>
    )
  }

  // ── Main form ────────────────────────────────────────────────────────────────

  const remaining = balance - totalAmount

  return (
    <div className={styles.page}>
      <div className={styles.formWrap} ref={formRef}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.logo}>PRAMAANA</div>
          <h1 className={styles.heading}>Submit Settlement</h1>
          {session && (
            <div className={styles.advanceMeta}>
              {session.suspense_purpose && (
                <span className={styles.purposeTag}>{session.suspense_purpose}</span>
              )}
              <div className={styles.balanceRow}>
                <span className={styles.balLabel}>Available Balance</span>
                <span className={styles.balAmount}>
                  {formatIndianCurrency(balance)}
                </span>
              </div>
              <div className={styles.balanceTrack}>
                <div
                  className={styles.balanceFill}
                  style={{
                    width: `${Math.min(100, ((session.total_settled_amount) / session.voucher_amount) * 100)}%`,
                  }}
                />
              </div>
              <div className={styles.balMeta}>
                <span>{formatIndianCurrency(session.total_settled_amount)} settled</span>
                <span>{formatIndianCurrency(session.voucher_amount)} total</span>
              </div>
            </div>
          )}
        </div>

        {/* Rows */}
        {rows.map((row, idx) => (
          <div key={row.id} className={styles.entryCard}>
            <div className={styles.entryHeader}>
              <span className={styles.entryNum}>Entry {idx + 1}</span>
              {rows.length > 1 && (
                <button
                  className={styles.removeBtn}
                  onClick={() => removeRow(row.id)}
                  aria-label="Remove entry"
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>

            {/* Type pills */}
            <div className={styles.typePills}>
              {(['expense', 'refund'] as const).map(t => (
                <button
                  key={t}
                  className={`${styles.typePill} ${row.entry_type === t ? styles.typePillActive : ''} ${t === 'refund' ? styles.typePillRefund : ''}`}
                  onClick={() => updateRow(row.id, { entry_type: t })}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            {/* Description */}
            <div className={styles.field}>
              <label className={styles.label}>
                Description <span className={styles.req}>*</span>
              </label>
              <input
                className={styles.input}
                placeholder="What was this for?"
                value={row.description}
                onChange={e => updateRow(row.id, { description: e.target.value })}
              />
            </div>

            {/* Amount */}
            <div className={styles.field}>
              <label className={styles.label}>
                Amount (₹) <span className={styles.req}>*</span>
              </label>
              <div className={styles.amountWrap}>
                <span className={styles.rupee}>₹</span>
                <input
                  className={styles.amountInput}
                  type="number"
                  inputMode="decimal"
                  placeholder="0.00"
                  min="0.01"
                  step="0.01"
                  value={row.amount}
                  onChange={e => updateRow(row.id, { amount: e.target.value })}
                />
              </div>
            </div>

            {/* Head of account */}
            <div className={styles.field}>
              <label className={styles.label}>Head of Account</label>
              <input
                className={styles.input}
                placeholder="e.g. Travel, Stationery"
                value={row.head_of_account}
                onChange={e => updateRow(row.id, { head_of_account: e.target.value })}
              />
            </div>

            {/* Reference */}
            <div className={styles.field}>
              <label className={styles.label}>Bill / Invoice Ref #</label>
              <input
                className={styles.input}
                placeholder="Optional invoice number"
                value={row.reference_number}
                onChange={e => updateRow(row.id, { reference_number: e.target.value })}
              />
            </div>

            {/* Invoice available toggle */}
            <button
              className={`${styles.invoiceToggle} ${row.invoice_available ? styles.invoiceOn : ''}`}
              onClick={() => updateRow(row.id, { invoice_available: !row.invoice_available })}
              type="button"
            >
              <span className={styles.toggleDot} />
              <span>Invoice / receipt available</span>
            </button>
          </div>
        ))}

        {/* Running total */}
        {rows.length > 0 && (
          <div className={styles.totalRow}>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>This submission</span>
              <span className={`${styles.totalAmt} ${totalAmount > balance ? styles.totalOver : ''}`}>
                {formatIndianCurrency(totalAmount)}
              </span>
            </div>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>Remaining after</span>
              <span className={`${styles.totalAmt} ${remaining < 0 ? styles.totalOver : ''}`}>
                {formatIndianCurrency(remaining)}
              </span>
            </div>
          </div>
        )}

        {/* Error */}
        {errMsg && (
          <div className={styles.errBanner}>
            <AlertCircle size={16} /> {errMsg}
          </div>
        )}

        {/* Actions */}
        <div className={styles.actions}>
          <button className={styles.addBtn} onClick={addRow} type="button">
            <PlusCircle size={17} /> Add another entry
          </button>
          <button
            className={styles.submitBtn}
            disabled={!canSubmit || pageState === 'submitting'}
            onClick={handleSubmit}
            type="button"
          >
            {pageState === 'submitting' ? (
              <><Loader2 size={18} className={styles.spin} /> Submitting…</>
            ) : (
              `Submit ${rows.length === 1 ? 'Entry' : `${rows.length} Entries`}`
            )}
          </button>
        </div>

        <p className={styles.footNote}>
          Entries are pending approval by the accounts team after submission.
        </p>
      </div>
    </div>
  )
}
