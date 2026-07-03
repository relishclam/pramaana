import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Loader2, Search, X, ChevronLeft, Building2, Wallet,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchVoucherTypes, fetchPaymentAccounts, fetchCostCentres, searchLedgers,
  type VoucherType, type PaymentAccount,
} from '@/lib/vouchers'
import { createSuspenseVoucher } from '@/lib/suspense'
import { supabase } from '@/lib/supabase'
import FoodStreamLoader from '@/components/FoodStreamLoader'

interface EntityResult { id: string; display_name: string }

const PAYMENT_MODES = ['upi', 'neft', 'rtgs', 'imps', 'cheque']

export default function SuspenseEntry() {
  const navigate   = useNavigate()
  const { user }   = useAuth()
  const companyId  = user?.activeCompany?.id  ?? ''
  const userId     = user?.id                 ?? ''

  // ── Reference data ─────────────────────────────────────────────────────────
  const [voucherTypes,  setVoucherTypes]  = useState<VoucherType[]>([])
  const [accounts,      setAccounts]      = useState<PaymentAccount[]>([])
  const [costCentres,   setCostCentres]   = useState<{ id: string; name: string; code: string }[]>([])
  const [refLoading,    setRefLoading]    = useState(true)

  useEffect(() => {
    if (!companyId) return
    Promise.all([
      fetchVoucherTypes(),
      fetchPaymentAccounts(companyId),
      fetchCostCentres(companyId),
    ]).then(([types, accs, ccs]) => {
      setVoucherTypes(types)
      setAccounts(accs)
      setCostCentres(ccs)
    }).catch(err => toast.error(err.message))
      .finally(() => setRefLoading(false))
  }, [companyId])

  // ── Entity (payee) typeahead ───────────────────────────────────────────────
  const [entityQuery,    setEntityQuery]    = useState('')
  const [entityResults,  setEntityResults]  = useState<EntityResult[]>([])
  const [entitySearching,setEntitySearching] = useState(false)
  const [selectedEntity, setSelectedEntity] = useState<EntityResult | null>(null)
  const [entityOpen,     setEntityOpen]     = useState(false)
  const entityTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const entityRef   = useRef<HTMLDivElement>(null)

  const handleEntityInput = (val: string) => {
    setEntityQuery(val)
    setSelectedEntity(null)
    setEntityOpen(true)
    if (entityTimer.current) clearTimeout(entityTimer.current)
    if (!val.trim()) { setEntityResults([]); return }
    entityTimer.current = setTimeout(async () => {
      setEntitySearching(true)
      const { data } = await supabase
        .schema('registry')
        .from('entities')
        .select('id, display_name')
        .ilike('display_name', `%${val}%`)
        .limit(10)
      setEntityResults((data ?? []) as EntityResult[])
      setEntitySearching(false)
    }, 300)
  }

  const selectEntity = (e: EntityResult) => {
    setSelectedEntity(e)
    setEntityQuery(e.display_name)
    setEntityResults([])
    setEntityOpen(false)
  }

  const clearEntity = () => {
    setSelectedEntity(null)
    setEntityQuery('')
    setEntityResults([])
  }

  // Close entity dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (entityRef.current && !entityRef.current.contains(e.target as Node)) {
        setEntityOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ── Advance ledger (Dr side) typeahead ────────────────────────────────────
  const [ledgerQuery,    setLedgerQuery]    = useState('')
  const [ledgerResults,  setLedgerResults]  = useState<{ id: string; name: string }[]>([])
  const [ledgerSearching,setLedgerSearching] = useState(false)
  const [selectedLedger, setSelectedLedger] = useState<{ id: string; name: string } | null>(null)
  const [ledgerOpen,     setLedgerOpen]     = useState(false)
  const ledgerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ledgerRef   = useRef<HTMLDivElement>(null)

  const handleLedgerInput = (val: string) => {
    setLedgerQuery(val)
    setSelectedLedger(null)
    setLedgerOpen(true)
    if (ledgerTimer.current) clearTimeout(ledgerTimer.current)
    if (!val.trim()) { setLedgerResults([]); return }
    ledgerTimer.current = setTimeout(async () => {
      setLedgerSearching(true)
      const results = await searchLedgers(companyId, val)
      setLedgerResults(results.map(r => ({ id: r.id, name: r.name })))
      setLedgerSearching(false)
    }, 300)
  }

  const selectLedger = (l: { id: string; name: string }) => {
    setSelectedLedger(l)
    setLedgerQuery(l.name)
    setLedgerResults([])
    setLedgerOpen(false)
  }

  const clearLedger = () => {
    setSelectedLedger(null)
    setLedgerQuery('')
    setLedgerResults([])
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ledgerRef.current && !ledgerRef.current.contains(e.target as Node)) {
        setLedgerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ── Form fields ───────────────────────────────────────────────────────────
  const [date,          setDate]          = useState(() => new Date().toISOString().slice(0, 10))
  const [amount,        setAmount]        = useState('')
  const [purpose,       setPurpose]       = useState('')
  const [narration,     setNarration]     = useState('')
  const [selectedAccount, setSelectedAccount] = useState<PaymentAccount | null>(null)
  const [paymentMode,   setPaymentMode]   = useState('')
  const [utrNumber,     setUtrNumber]     = useState('')
  const [chequeNumber,  setChequeNumber]  = useState('')
  const [chequeDate,    setChequeDate]    = useState('')
  const [costCentreId,  setCostCentreId]  = useState('')
  const [submitting,    setSubmitting]    = useState(false)

  const isBank     = selectedAccount?.type === 'bank'
  const amountNum  = parseFloat(amount) || 0
  const paymentType = voucherTypes.find(t => t.nature === 'payment')

  const canSubmit =
    selectedEntity !== null &&
    amountNum > 0 &&
    purpose.trim().length > 0 &&
    selectedAccount !== null &&
    selectedLedger !== null &&
    paymentType !== undefined &&
    !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await createSuspenseVoucher(
        {
          company_id:       companyId,
          voucher_type_id:  paymentType!.id,
          voucher_date:     date,
          entity_id:        selectedEntity!.id,
          amount:           amountNum,
          suspense_purpose: purpose.trim(),
          payment_mode:     isBank ? (paymentMode || null) : 'cash',
          bank_ledger_id:   isBank ? selectedAccount!.id : null,
          cost_centre_id:   costCentreId || null,
          narration:        narration.trim() || null,
          created_by:       userId,
        },
        [
          { ledger_id: selectedLedger!.id,  entry_type: 'Dr', amount: amountNum, narration: purpose.trim() },
          { ledger_id: selectedAccount!.id, entry_type: 'Cr', amount: amountNum, narration: purpose.trim() },
        ],
      )
      toast.success('Suspense advance created — awaiting approval')
      navigate('/suspense')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create advance')
    } finally {
      setSubmitting(false)
    }
  }

  if (refLoading) {
    return <FoodStreamLoader label="Loading" />
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <button className={styles.backBtn} onClick={() => navigate('/suspense')}>
          <ChevronLeft size={15} /> Suspense
        </button>
        <h1 className={styles.pageTitle}>New Suspense Advance</h1>
      </div>

      <div className={styles.card}>

        {/* ── Row 1: Payee + Date ─────────────────────────────────────── */}
        <div className={styles.row2}>

          {/* Payee */}
          <div className={styles.field}>
            <label className={styles.label}>Staff Payee <span className={styles.req}>*</span></label>
            <div className={styles.typeahead} ref={entityRef}>
              <Search size={13} className={styles.typeaheadIcon} />
              <input
                className={styles.typeaheadInput}
                placeholder="Search by name…"
                value={entityQuery}
                onChange={e => handleEntityInput(e.target.value)}
                onFocus={() => entityQuery && setEntityOpen(true)}
              />
              {entitySearching
                ? <Loader2 size={13} className={`${styles.typeaheadSuffix} ${styles.spin}`} />
                : selectedEntity
                  ? <button className={styles.clearBtn} onClick={clearEntity}><X size={12} /></button>
                  : null
              }
              {entityOpen && entityResults.length > 0 && (
                <div className={styles.dropdown}>
                  {entityResults.map(e => (
                    <button key={e.id} className={styles.dropdownItem} onClick={() => selectEntity(e)}>
                      {e.display_name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {selectedEntity && (
              <div className={styles.selectedTag}>
                <Building2 size={11} /> {selectedEntity.display_name}
              </div>
            )}
          </div>

          {/* Date */}
          <div className={styles.field}>
            <label className={styles.label}>Date <span className={styles.req}>*</span></label>
            <input
              type="date"
              className={styles.input}
              value={date}
              onChange={e => setDate(e.target.value)}
            />
          </div>
        </div>

        {/* ── Row 2: Purpose + Amount ─────────────────────────────────── */}
        <div className={styles.row2}>
          <div className={styles.field}>
            <label className={styles.label}>Purpose <span className={styles.req}>*</span></label>
            <input
              className={styles.input}
              placeholder="e.g. Field visit expenses for Delhi trip"
              value={purpose}
              onChange={e => setPurpose(e.target.value)}
              maxLength={200}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Advance Amount <span className={styles.req}>*</span></label>
            <div className={styles.amountWrap}>
              <span className={styles.rupee}>₹</span>
              <input
                type="number"
                className={styles.amountInput}
                placeholder="0.00"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                min={0}
                step={0.01}
              />
            </div>
          </div>
        </div>

        {/* ── From Account ─────────────────────────────────────────────── */}
        <div className={styles.field}>
          <label className={styles.label}>From Account (Credit) <span className={styles.req}>*</span></label>
          <div className={styles.accountGrid}>
            {accounts.map(acc => (
              <button
                key={acc.id}
                className={`${styles.accountCard} ${selectedAccount?.id === acc.id ? styles.accountSelected : ''}`}
                onClick={() => { setSelectedAccount(acc); setPaymentMode('') }}
              >
                <div className={styles.accountIcon}>
                  {acc.type === 'cash' ? <Wallet size={16} /> : <Building2 size={16} />}
                </div>
                <div className={styles.accountName}>{acc.name}</div>
                {acc.bank_name && <div className={styles.accountSub}>{acc.bank_name}</div>}
                {acc.account_number && <div className={styles.accountSub}>••• {acc.account_number.slice(-4)}</div>}
              </button>
            ))}
          </div>
        </div>

        {/* ── Payment Mode (bank only) ──────────────────────────────────── */}
        {isBank && (
          <div className={styles.field}>
            <label className={styles.label}>Payment Mode</label>
            <div className={styles.modeGrid}>
              {PAYMENT_MODES.map(m => (
                <button
                  key={m}
                  className={`${styles.modePill} ${paymentMode === m ? styles.modeSelected : ''}`}
                  onClick={() => setPaymentMode(paymentMode === m ? '' : m)}
                >
                  {m.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* UTR / Cheque details */}
        {isBank && paymentMode && paymentMode !== 'cheque' && (
          <div className={styles.row2}>
            <div className={styles.field}>
              <label className={styles.label}>UTR / Reference Number</label>
              <input className={styles.input} placeholder="Optional" value={utrNumber} onChange={e => setUtrNumber(e.target.value)} />
            </div>
            <div className={styles.field} />
          </div>
        )}
        {isBank && paymentMode === 'cheque' && (
          <div className={styles.row2}>
            <div className={styles.field}>
              <label className={styles.label}>Cheque Number</label>
              <input className={styles.input} placeholder="e.g. 123456" value={chequeNumber} onChange={e => setChequeNumber(e.target.value)} />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Cheque Date</label>
              <input type="date" className={styles.input} value={chequeDate} onChange={e => setChequeDate(e.target.value)} />
            </div>
          </div>
        )}

        {/* ── Advance Ledger (Dr) ───────────────────────────────────────── */}
        <div className={styles.field}>
          <label className={styles.label}>
            Advance Ledger (Debit) <span className={styles.req}>*</span>
            <span className={styles.hint}> — e.g. "Staff Advances", "Advance to Employees"</span>
          </label>
          <div className={styles.typeahead} ref={ledgerRef}>
            <Search size={13} className={styles.typeaheadIcon} />
            <input
              className={styles.typeaheadInput}
              placeholder="Search ledger…"
              value={ledgerQuery}
              onChange={e => handleLedgerInput(e.target.value)}
              onFocus={() => ledgerQuery && setLedgerOpen(true)}
            />
            {ledgerSearching
              ? <Loader2 size={13} className={`${styles.typeaheadSuffix} ${styles.spin}`} />
              : selectedLedger
                ? <button className={styles.clearBtn} onClick={clearLedger}><X size={12} /></button>
                : null
            }
            {ledgerOpen && ledgerResults.length > 0 && (
              <div className={styles.dropdown}>
                {ledgerResults.map(l => (
                  <button key={l.id} className={styles.dropdownItem} onClick={() => selectLedger(l)}>
                    {l.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {selectedLedger && (
            <div className={styles.selectedTag}>Dr → {selectedLedger.name}</div>
          )}
        </div>

        {/* ── Optional: Cost Centre + Narration ─────────────────────────── */}
        <div className={styles.row2}>
          {costCentres.length > 0 && (
            <div className={styles.field}>
              <label className={styles.label}>Cost Centre</label>
              <select className={styles.select} value={costCentreId} onChange={e => setCostCentreId(e.target.value)}>
                <option value="">— None —</option>
                {costCentres.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className={styles.field}>
            <label className={styles.label}>Narration</label>
            <input
              className={styles.input}
              placeholder="Optional internal note"
              value={narration}
              onChange={e => setNarration(e.target.value)}
            />
          </div>
        </div>

        {/* ── Accounting preview ─────────────────────────────────────────── */}
        {amountNum > 0 && selectedLedger && selectedAccount && (
          <div className={styles.entriesPreview}>
            <div className={styles.entriesTitle}>Accounting Entries</div>
            <div className={styles.entriesRow}>
              <span className={styles.entryDr}>Dr</span>
              <span className={styles.entryLedger}>{selectedLedger.name}</span>
              <span className={styles.entryAmt}>₹{amountNum.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
            </div>
            <div className={styles.entriesRow}>
              <span className={styles.entryCr}>Cr</span>
              <span className={styles.entryLedger}>{selectedAccount.name}</span>
              <span className={styles.entryAmt}>₹{amountNum.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
            </div>
          </div>
        )}

        {/* ── Actions ───────────────────────────────────────────────────── */}
        <div className={styles.actions}>
          <button className={styles.btnCancel} onClick={() => navigate('/suspense')}>
            Cancel
          </button>
          <button className={styles.btnSubmit} onClick={handleSubmit} disabled={!canSubmit}>
            {submitting
              ? <><Loader2 size={14} className={styles.spin} /> Creating…</>
              : 'Create Advance'
            }
          </button>
        </div>

      </div>
    </div>
  )
}
