import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Plus, Trash2, Check, X, Loader2, Search, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchVoucherForEdit,
  fetchCostCentres,
  fetchBankLedgers,
  searchLedgers,
  updateDraftVoucher,
  getNextSequence,
  formatIndianCurrency,
  type VoucherEntryRow,
} from '@/lib/vouchers'
import { supabase } from '@/lib/supabase'
import FoodStreamLoader from '@/components/FoodStreamLoader'
import styles from './VoucherEntry.module.css'

// ── Constants (same as VoucherEntry) ─────────────────────────────────────────

const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'NEFT', 'RTGS', 'IMPS']
const BANK_MODES    = new Set(['Bank', 'Cheque', 'NEFT', 'RTGS', 'IMPS'])
const UTR_MODES     = new Set(['NEFT', 'RTGS', 'IMPS', 'UPI'])
const NEEDS_ENTITY  = new Set(['payment', 'receipt'])
const NEEDS_PAYMENT = new Set(['payment', 'receipt', 'contra'])

// ── Types ─────────────────────────────────────────────────────────────────────

interface EntityOption {
  entity_id: string
  display_name: string
  mobile: string | null
  role: string
  upi_id: string | null
  bank_name: string | null
  account_number: string | null
  ifsc: string | null
}

interface CostCentre { id: string; name: string; code: string }
interface BankLedger  { id: string; name: string; bank_name: string | null; account_number: string | null }

function emptyEntry(): VoucherEntryRow {
  return { ledger_id: '', ledger_name: '', entry_type: 'Dr', amount: '', narration: '' }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function VoucherEdit() {
  const { id: voucherId } = useParams<{ id: string }>()
  const { user }          = useAuth()
  const navigate          = useNavigate()

  const companyId   = user?.activeCompany?.id   ?? ''
  const companyCode = user?.activeCompany?.code  ?? ''

  // ── Voucher type (read-only — cannot change type on an existing voucher)
  const [voucherTypeId,    setVoucherTypeId]    = useState('')
  const [voucherTypeName,  setVoucherTypeName]  = useState('')
  const [voucherNature,    setVoucherNature]    = useState('')
  const [voucherPrefix,    setVoucherPrefix]    = useState('')
  const [voucherNumber,    setVoucherNumber]    = useState('')

  // ── Header state ──────────────────────────────────────────────────────────
  const [voucherDate,   setVoucherDate]   = useState('')
  const [refNumber,     setRefNumber]     = useState('')
  const [narration,     setNarration]     = useState('')
  const [paymentMode,   setPaymentMode]   = useState('')
  const [costCentreId,  setCostCentreId]  = useState('')
  const [bankLedgerId,  setBankLedgerId]  = useState('')
  const [utrNumber,     setUtrNumber]     = useState('')
  const [chequeNumber,  setChequeNumber]  = useState('')
  const [chequeDate,    setChequeDate]    = useState('')

  // ── Entity typeahead ──────────────────────────────────────────────────────
  const [entitySearch,   setEntitySearch]   = useState('')
  const [entityOptions,  setEntityOptions]  = useState<EntityOption[]>([])
  const [entityId,       setEntityId]       = useState<string | null>(null)
  const [entityLabel,    setEntityLabel]    = useState('')
  const [entityLoading,  setEntityLoading]  = useState(false)
  const entityTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Lookup data ───────────────────────────────────────────────────────────
  const [costCentres, setCostCentres] = useState<CostCentre[]>([])
  const [bankLedgers, setBankLedgers] = useState<BankLedger[]>([])
  const [loadingInit, setLoadingInit] = useState(true)
  const [notFound,    setNotFound]    = useState(false)
  const [notDraft,    setNotDraft]    = useState(false)

  // ── Entry rows ─────────────────────────────────────────────────────────────
  const [entries, setEntries] = useState<VoucherEntryRow[]>([emptyEntry(), emptyEntry()])

  // ── Submission ─────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false)

  // ── Load existing voucher ─────────────────────────────────────────────────
  useEffect(() => {
    if (!voucherId || !companyId) return

    Promise.all([
      fetchVoucherForEdit(voucherId),
      fetchCostCentres(companyId),
      fetchBankLedgers(companyId),
    ]).then(([voucher, centres, banks]) => {
      if (voucher.status !== 'draft') {
        setNotDraft(true)
        setLoadingInit(false)
        return
      }

      setVoucherTypeId(voucher.voucher_type.id)
      setVoucherTypeName(voucher.voucher_type.name)
      setVoucherNature(voucher.voucher_type.nature)
      setVoucherPrefix(voucher.voucher_type.prefix)
      setVoucherNumber(voucher.voucher_number)
      setVoucherDate(voucher.voucher_date)
      setNarration(voucher.narration ?? '')
      setRefNumber(voucher.ref_document_number ?? '')
      setEntityId(voucher.entity_id)
      setCostCentreId(voucher.cost_centre_id ?? '')
      setBankLedgerId(voucher.bank_ledger_id ?? '')
      setUtrNumber(voucher.utr_number ?? '')
      setChequeNumber(voucher.cheque_number ?? '')
      setChequeDate(voucher.cheque_date ?? '')

      // Capitalise stored payment mode to match pill labels
      if (voucher.payment_mode) {
        const stored = voucher.payment_mode.toLowerCase()
        const matched = PAYMENT_MODES.find(m => m.toLowerCase() === stored)
        setPaymentMode(matched ?? '')
      }

      // If there's an entity, resolve its display name
      if (voucher.entity_id) {
        supabase
          .schema('registry')
          .from('entities')
          .select('display_name')
          .eq('id', voucher.entity_id)
          .single()
          .then(({ data }) => {
            if (data) setEntityLabel((data as { display_name: string }).display_name)
          })
      }

      // Map loaded entries to VoucherEntryRow shape
      if (voucher.entries.length >= 2) {
        setEntries(voucher.entries.map(e => ({
          ledger_id:   e.ledger_id,
          ledger_name: e.ledger_name,
          entry_type:  e.entry_type,
          amount:      String(e.amount),
          narration:   e.narration ?? '',
        })))
      }

      setCostCentres(centres)
      setBankLedgers(banks)
      setLoadingInit(false)
    }).catch(err => {
      if (err.message?.includes('No rows found') || err.message?.includes('PGRST116')) {
        setNotFound(true)
      } else {
        toast.error(err.message ?? 'Failed to load voucher')
      }
      setLoadingInit(false)
    })
  }, [voucherId, companyId])

  // ── Derived flags ─────────────────────────────────────────────────────────
  const needsEntity  = NEEDS_ENTITY.has(voucherNature)
  const needsPayment = NEEDS_PAYMENT.has(voucherNature)
  const needsBank    = needsPayment && BANK_MODES.has(paymentMode)
  const needsUtr     = needsPayment && UTR_MODES.has(paymentMode)
  const needsCheque  = needsPayment && paymentMode === 'Cheque'

  // ── Entity search ─────────────────────────────────────────────────────────
  const searchEntities = useCallback(async (q: string) => {
    if (!q.trim() || !companyId) { setEntityOptions([]); return }
    setEntityLoading(true)
    try {
      type RawEntity = {
        id: string; display_name: string; mobile: string | null
        upi_id: string | null; bank_name: string | null
        account_number: string | null; ifsc: string | null
      }
      type RawRole = { entity_id: string; role: string }

      const { data: entities, error: eErr } = await supabase
        .schema('registry')
        .from('entities')
        .select('id, display_name, mobile, upi_id, bank_name, account_number, ifsc')
        .ilike('display_name', `%${q}%`)
        .limit(20)

      if (eErr || !entities?.length) { setEntityOptions([]); return }

      const entityIds = (entities as RawEntity[]).map(e => e.id)

      const { data: roles } = await supabase
        .schema('registry')
        .from('entity_roles')
        .select('entity_id, role')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .in('role', ['Vendor', 'Supplier', 'Staff', 'Management', 'Contractor', 'Government', 'Auditor'])
        .in('entity_id', entityIds)

      if (!roles?.length) { setEntityOptions([]); return }

      const entityMap = new Map<string, RawEntity>(
        (entities as RawEntity[]).map(e => [e.id, e])
      )
      // Deduplicate by entity_id — an entity may have multiple roles in the same company;
      // show each entity only once (first matching role).
      const seen = new Set<string>()
      setEntityOptions(
        (roles as RawRole[])
          .filter(r => entityMap.has(r.entity_id) && !seen.has(r.entity_id) && seen.add(r.entity_id) !== undefined)
          .slice(0, 10)
          .map(r => {
            const e = entityMap.get(r.entity_id)!
            return {
              entity_id:      r.entity_id,
              display_name:   e.display_name,
              mobile:         e.mobile,
              role:           r.role,
              upi_id:         e.upi_id,
              bank_name:      e.bank_name,
              account_number: e.account_number,
              ifsc:           e.ifsc,
            }
          })
      )
    } finally {
      setEntityLoading(false)
    }
  }, [companyId])

  const handleEntityInput = (val: string) => {
    setEntitySearch(val)
    if (entityTimer.current) clearTimeout(entityTimer.current)
    entityTimer.current = setTimeout(() => searchEntities(val), 300)
  }

  const selectEntity = (opt: EntityOption) => {
    setEntityId(opt.entity_id)
    setEntityLabel(`${opt.display_name} · ${opt.role}`)
    setEntitySearch('')
    setEntityOptions([])
  }

  const clearEntity = () => { setEntityId(null); setEntityLabel('') }

  // ── Entry row helpers ─────────────────────────────────────────────────────
  const updateEntry = (index: number, field: keyof VoucherEntryRow, value: string) => {
    setEntries(prev => prev.map((e, i) => i === index ? { ...e, [field]: value } : e))
  }

  const addEntry = () => setEntries(prev => [...prev, emptyEntry()])

  const removeEntry = (index: number) => {
    if (entries.length <= 2) { toast.error('Minimum 2 entry rows required'); return }
    setEntries(prev => prev.filter((_, i) => i !== index))
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const drTotal  = entries.reduce((s, e) => e.entry_type === 'Dr' ? s + (parseFloat(e.amount) || 0) : s, 0)
  const crTotal  = entries.reduce((s, e) => e.entry_type === 'Cr' ? s + (parseFloat(e.amount) || 0) : s, 0)
  const diff     = Math.abs(drTotal - crTotal)
  const balanced = drTotal > 0 && crTotal > 0 && Math.round(drTotal * 100) === Math.round(crTotal * 100)

  // ── Validation ────────────────────────────────────────────────────────────
  const validate = () => {
    if (!voucherDate)                             { toast.error('Voucher date is required');              return false }
    if (needsEntity && !entityId)                 { toast.error('Party is required for this voucher type'); return false }
    if (needsPayment && !paymentMode)             { toast.error('Payment mode is required');              return false }
    if (needsBank && !bankLedgerId)               { toast.error('Bank ledger is required');               return false }
    if (entries.length < 2)                       { toast.error('At least 2 entry rows required');        return false }
    if (entries.some(e => !e.ledger_id))          { toast.error('All entry rows must have a ledger');     return false }
    if (entries.some(e => !(parseFloat(e.amount) > 0))) { toast.error('All amounts must be greater than 0'); return false }
    if (!balanced)                                { toast.error('Voucher is unbalanced — Dr must equal Cr'); return false }
    return true
  }

  // ── Build entry payloads ──────────────────────────────────────────────────
  const buildEntryPayloads = () =>
    entries.map((e, i) => ({
      voucher_id:  '',        // filled by updateDraftVoucher
      ledger_id:   e.ledger_id,
      entry_type:  e.entry_type,
      amount:      parseFloat(e.amount),
      narration:   e.narration || null,
      sort_order:  i,
    }))

  // ── Save as draft ─────────────────────────────────────────────────────────
  const handleSaveDraft = async () => {
    if (!voucherId) return
    if (entries.some(e => !e.ledger_id)) {
      toast.error('Fill in all ledger fields before saving draft')
      return
    }
    setSaving(true)
    try {
      await updateDraftVoucher(
        voucherId,
        {
          voucher_date:        voucherDate,
          narration:           narration || null,
          entity_id:           entityId,
          payment_mode:        needsPayment ? paymentMode.toLowerCase() || null : null,
          bank_ledger_id:      needsBank ? bankLedgerId || null : null,
          cheque_number:       needsCheque ? chequeNumber || null : null,
          cheque_date:         needsCheque ? chequeDate || null : null,
          utr_number:          needsUtr ? utrNumber || null : null,
          cost_centre_id:      costCentreId || null,
          ref_document_number: refNumber || null,
          amount:              drTotal,
          status:              'draft',
        },
        buildEntryPayloads(),
      )
      toast.success('Draft saved')
      navigate('/vouchers')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save draft')
    } finally {
      setSaving(false)
    }
  }

  // ── Submit for approval ───────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!voucherId || !validate()) return
    setSaving(true)
    try {
      // Generate voucher number (replaces DRAFT)
      const newVoucherNumber = await getNextSequence(companyId, companyCode, voucherPrefix)
      await updateDraftVoucher(
        voucherId,
        {
          voucher_number:      newVoucherNumber,
          voucher_date:        voucherDate,
          narration:           narration || null,
          entity_id:           entityId,
          amount:              drTotal,
          payment_mode:        needsPayment ? paymentMode.toLowerCase() || null : null,
          bank_ledger_id:      needsBank ? bankLedgerId || null : null,
          cheque_number:       needsCheque ? chequeNumber || null : null,
          cheque_date:         needsCheque ? chequeDate || null : null,
          utr_number:          needsUtr ? utrNumber || null : null,
          cost_centre_id:      costCentreId || null,
          ref_document_number: refNumber || null,
          status:              'pending_approval',
        },
        buildEntryPayloads(),
      )
      toast.success('Voucher submitted for approval')
      navigate('/vouchers')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit voucher')
    } finally {
      setSaving(false)
    }
  }

  // ── Render: loading ───────────────────────────────────────────────────────
  if (loadingInit) {
    return <FoodStreamLoader label="Loading voucher" />
  }

  if (notFound) {
    return (
      <div className={styles.page}>
        <div className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Voucher Not Found</h1>
        </div>
        <p style={{ color: 'var(--text-muted)', padding: '1rem' }}>
          This voucher does not exist or you don't have access to it.
        </p>
        <button className={styles.btnDraft} onClick={() => navigate('/vouchers')} style={{ margin: '0 1rem' }}>
          Back to Register
        </button>
      </div>
    )
  }

  if (notDraft) {
    return (
      <div className={styles.page}>
        <div className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Cannot Edit Voucher</h1>
        </div>
        <p style={{ color: 'var(--text-muted)', padding: '1rem' }}>
          Only <strong>Draft</strong> vouchers can be edited. This voucher has already been submitted or posted.
        </p>
        <button className={styles.btnDraft} onClick={() => navigate('/vouchers')} style={{ margin: '0 1rem' }}>
          Back to Register
        </button>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>
          Edit Voucher
          <span style={{ marginLeft: '0.75rem', fontSize: '0.875rem', fontWeight: 400, color: 'var(--text-muted)' }}>
            {voucherNumber} · {voucherTypeName}
          </span>
        </h1>
      </div>

      {/* ── Voucher type — read-only badge ────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.segmented}>
          <button
            type="button"
            className={`${styles.seg} ${styles.segActive}`}
            disabled
            aria-disabled="true"
          >
            {voucherTypeName}
          </button>
          <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)', alignSelf: 'center' }}>
            (type cannot be changed)
          </span>
        </div>
      </div>

      {/* ── Date ──────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: '0.25rem' }}>
        <div className={styles.row2} style={{ maxWidth: 360 }}>
          <div className={styles.field}>
            <label className={styles.label}>Voucher Date <span className={styles.req}>*</span></label>
            <input
              type="date"
              className={styles.input}
              value={voucherDate}
              onChange={e => setVoucherDate(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* ── Two-column layout ────────────────────────────────────────── */}
      <div className={styles.layout}>
        {/* ── LEFT COLUMN ─────────────────────────────────────────────── */}
        <div className={styles.leftCol}>

          {/* Reference No. */}
          <div className={styles.field}>
            <label className={styles.label}>Reference No. <span className={styles.labelOpt}>(optional)</span></label>
            <input
              className={styles.input}
              value={refNumber}
              onChange={e => setRefNumber(e.target.value)}
              placeholder="Invoice / cheque / PO no."
            />
          </div>

          {/* Entity (Party) */}
          {needsEntity && (
            <div className={styles.field}>
              <label className={styles.label}>Party <span className={styles.req}>*</span></label>
              {entityId ? (
                <div className={styles.entitySelected}>
                  <span>{entityLabel}</span>
                  <button type="button" className={styles.entityClear} onClick={clearEntity}><X size={13} /></button>
                </div>
              ) : (
                <div className={styles.typeaheadWrap}>
                  <Search size={13} className={styles.typeaheadIcon} />
                  <input
                    className={`${styles.input} ${styles.typeaheadInput}`}
                    value={entitySearch}
                    onChange={e => handleEntityInput(e.target.value)}
                    placeholder="Search vendors, staff, contractors…"
                  />
                  {entityLoading && <Loader2 size={13} className={`${styles.spin} ${styles.typeaheadSpinner}`} />}
                  {entityOptions.length > 0 && (
                    <ul className={styles.typeaheadDropdown}>
                      {entityOptions.map(opt => (
                        <li key={opt.entity_id} className={styles.typeaheadOption} onMouseDown={() => selectEntity(opt)}>
                          <span className={styles.entityName}>{opt.display_name}</span>
                          <span className={styles.entityMeta}>
                            <span className={styles.roleTag}>{opt.role}</span>
                            {opt.mobile && <span>{opt.mobile}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Payment Mode */}
          {needsPayment && (
            <div className={styles.field}>
              <label className={styles.label}>Payment Mode <span className={styles.req}>*</span></label>
              <div className={styles.modeGrid}>
                {PAYMENT_MODES.map(m => (
                  <button
                    key={m}
                    type="button"
                    className={`${styles.modeBtn} ${paymentMode === m ? styles.modeBtnActive : ''}`}
                    onClick={() => setPaymentMode(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Bank Ledger */}
          {needsBank && (
            <div className={styles.field}>
              <label className={styles.label}>Bank Ledger <span className={styles.req}>*</span></label>
              {bankLedgers.length === 0 ? (
                <p className={styles.fieldWarn}>
                  <AlertTriangle size={13} /> No bank accounts set up yet.
                </p>
              ) : (
                <select className={styles.select} value={bankLedgerId} onChange={e => setBankLedgerId(e.target.value)}>
                  <option value="">— Select bank account —</option>
                  {bankLedgers.map(b => (
                    <option key={b.id} value={b.id}>
                      {b.name}{b.account_number ? ` (${b.account_number.slice(-4)})` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* UTR */}
          {needsUtr && (
            <div className={styles.field}>
              <label className={styles.label}>UTR / Transaction Ref</label>
              <input className={styles.input} value={utrNumber} onChange={e => setUtrNumber(e.target.value)} placeholder="UTR number" />
            </div>
          )}

          {/* Cheque */}
          {needsCheque && (
            <div className={styles.row2}>
              <div className={styles.field}>
                <label className={styles.label}>Cheque Number</label>
                <input className={styles.input} value={chequeNumber} onChange={e => setChequeNumber(e.target.value)} placeholder="000000" />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Cheque Date</label>
                <input type="date" className={styles.input} value={chequeDate} onChange={e => setChequeDate(e.target.value)} />
              </div>
            </div>
          )}

          {/* Narration */}
          <div className={styles.field}>
            <label className={styles.label}>Narration <span className={styles.labelOpt}>(optional)</span></label>
            <textarea
              className={styles.textarea}
              rows={2}
              value={narration}
              onChange={e => setNarration(e.target.value)}
              placeholder="Being payment towards…"
            />
          </div>

          {/* Cost Centre */}
          {costCentres.length > 0 && (
            <div className={styles.field}>
              <label className={styles.label}>Cost Centre <span className={styles.labelOpt}>(optional)</span></label>
              <select className={styles.select} value={costCentreId} onChange={e => setCostCentreId(e.target.value)}>
                <option value="">— None —</option>
                {costCentres.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* ── RIGHT COLUMN: Entry rows ──────────────────────────────────── */}
        <div className={styles.rightCol}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionLabel}>Accounting Entries</span>
          </div>

          <div className={styles.entriesTable}>
            <div className={styles.entryHeader}>
              <span style={{ flex: 3 }}>Ledger</span>
              <span style={{ width: 68, textAlign: 'center' }}>Dr / Cr</span>
              <span style={{ width: 110, textAlign: 'right' }}>Amount</span>
              <span style={{ flex: 2 }}>Narration</span>
              <span style={{ width: 32 }} />
            </div>

            {entries.map((entry, idx) => (
              <EntryRow
                key={idx}
                entry={entry}
                index={idx}
                companyId={companyId}
                onChange={updateEntry}
                onRemove={removeEntry}
              />
            ))}
          </div>

          <button className={styles.addRowBtn} type="button" onClick={addEntry}>
            <Plus size={14} /> Add Row
          </button>

          {/* Totals */}
          <div className={styles.totals}>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Dr Total</span>
              <span className={styles.totalAmount}>{formatIndianCurrency(drTotal)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Cr Total</span>
              <span className={styles.totalAmount}>{formatIndianCurrency(crTotal)}</span>
            </div>
            <div className={`${styles.totalRow} ${styles.totalDiff}`}>
              <span className={styles.totalLabel}>Difference</span>
              <span className={styles.totalAmount} style={{ color: diff === 0 ? 'var(--success)' : 'var(--error)' }}>
                {formatIndianCurrency(diff)}
              </span>
            </div>
            <div className={`${styles.balanceStatus} ${balanced ? styles.balanced : styles.unbalanced}`}>
              {balanced
                ? <><Check size={14} /> Balanced</>
                : <><X size={14} /> Unbalanced</>
              }
            </div>
          </div>

          {/* Actions */}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.btnCancel ?? styles.btnDraft}
              onClick={() => navigate('/vouchers')}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className={styles.btnDraft}
              onClick={handleSaveDraft}
              disabled={saving}
            >
              {saving ? <Loader2 size={14} className={styles.spin} /> : null}
              Save as Draft
            </button>
            <button
              type="button"
              className={styles.btnSubmit}
              onClick={handleSubmit}
              disabled={saving || !balanced}
              title={!balanced ? 'Voucher must be balanced before submitting' : ''}
            >
              {saving ? <Loader2 size={14} className={styles.spin} /> : <Check size={14} />}
              Submit for Approval
            </button>
          </div>
        </div>
      </div>

      {/* Expose voucherTypeId to satisfy linting — used in submit flow via voucherPrefix */}
      <input type="hidden" value={voucherTypeId} />
    </div>
  )
}

// ── Entry Row sub-component (identical to VoucherEntry.tsx) ──────────────────

interface EntryRowProps {
  entry: VoucherEntryRow
  index: number
  companyId: string
  onChange: (index: number, field: keyof VoucherEntryRow, value: string) => void
  onRemove: (index: number) => void
}

function EntryRow({ entry, index, companyId, onChange, onRemove }: EntryRowProps) {
  const [query,   setQuery]   = useState('')
  const [options, setOptions] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSearch = (val: string) => {
    setQuery(val)
    if (!val.trim()) { setOptions([]); return }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setLoading(true)
      const results = await searchLedgers(companyId, val)
      setOptions(results.map(r => ({ id: r.id, name: r.name })))
      setLoading(false)
    }, 250)
  }

  const select = (opt: { id: string; name: string }) => {
    onChange(index, 'ledger_id',   opt.id)
    onChange(index, 'ledger_name', opt.name)
    setQuery('')
    setOptions([])
  }

  return (
    <div className={styles.entryRow}>
      {/* Ledger typeahead */}
      <div className={styles.entryLedger}>
        {entry.ledger_id ? (
          <div className={styles.ledgerChip}>
            <span>{entry.ledger_name}</span>
            <button type="button" className={styles.chipClear} onClick={() => {
              onChange(index, 'ledger_id',   '')
              onChange(index, 'ledger_name', '')
            }}><X size={11} /></button>
          </div>
        ) : (
          <div className={styles.typeaheadWrap}>
            <input
              className={`${styles.input} ${styles.entryInput}`}
              value={query}
              onChange={e => handleSearch(e.target.value)}
              placeholder="Search ledger…"
            />
            {loading && <Loader2 size={11} className={`${styles.spin} ${styles.typeaheadSpinner}`} />}
            {options.length > 0 && (
              <ul className={styles.typeaheadDropdown}>
                {options.map(opt => (
                  <li key={opt.id} className={styles.typeaheadOption} onMouseDown={() => select(opt)}>
                    {opt.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Dr/Cr toggle */}
      <div className={styles.drCrToggle}>
        {(['Dr', 'Cr'] as const).map(t => (
          <button
            key={t}
            type="button"
            className={`${styles.drCrBtn} ${entry.entry_type === t ? styles.drCrBtnActive : ''}`}
            onClick={() => onChange(index, 'entry_type', t)}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Amount */}
      <input
        className={`${styles.input} ${styles.amountInput}`}
        type="number"
        step="0.01"
        min="0"
        value={entry.amount}
        onChange={e => onChange(index, 'amount', e.target.value)}
        placeholder="0.00"
      />

      {/* Row narration */}
      <input
        className={`${styles.input} ${styles.rowNarration}`}
        value={entry.narration}
        onChange={e => onChange(index, 'narration', e.target.value)}
        placeholder="Optional…"
      />

      {/* Delete */}
      <button type="button" className={styles.deleteRowBtn} onClick={() => onRemove(index)}>
        <Trash2 size={13} />
      </button>
    </div>
  )
}
