import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Plus, Trash2, Check, X, Loader2, Search, AlertTriangle, ScanLine, Paperclip, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchVoucherTypes,
  fetchCostCentres,
  fetchBankLedgers,
  searchLedgers,
  saveDraftVoucher,
  submitVoucher,
  formatIndianCurrency,
  fetchTaxLedgers,
  type VoucherType,
  type VoucherEntryRow,
  type TaxLedger,
} from '@/lib/vouchers'
import { supabase } from '@/lib/supabase'
import SimplifiedPaymentEntry from './SimplifiedPaymentEntry'
import InvoiceScanModal from '@/components/InvoiceScanModal'
import { uploadVoucherAttachments, formatFileSize } from '@/lib/attachments'
import styles from './VoucherEntry.module.css'

// ── Constants ─────────────────────────────────────────────────────────────────

const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'NEFT', 'RTGS', 'IMPS']
const BANK_MODES    = new Set(['Bank', 'Cheque', 'NEFT', 'RTGS', 'IMPS'])
const UTR_MODES     = new Set(['NEFT', 'RTGS', 'IMPS', 'UPI'])
const NEEDS_ENTITY   = new Set(['payment', 'receipt'])
const NEEDS_PAYMENT  = new Set(['payment', 'receipt', 'contra'])         // payment mode required
const SHOWS_PAYMENT  = new Set(['payment', 'receipt', 'contra', 'purchase', 'sales']) // field visible

// ── Types ─────────────────────────────────────────────────────────────────────

interface EntityOption {
  entity_id: string
  display_name: string
  mobile: string | null
  role: string
  gstin: string | null
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

export default function VoucherEntry() {
  const { user } = useAuth()
  const navigate  = useNavigate()
  const location  = useLocation()
  const companyId   = user?.activeCompany?.id   ?? ''
  const companyCode = user?.activeCompany?.code  ?? ''
  const userId      = user?.id                   ?? ''

  // ── fromScan prefill (passed via navigate state from CreateVoucherButton) ─
  const fromScanState = (location.state as {
    fromScan?: boolean
    scanId?:   string
    prefill?: {
      voucher_type?: string
      party_name?:   string | null
      party_gstin?:  string | null
      amount?:       number
      narration?:    string
      bill_ref?:     string | null
    }
  } | null)

  // ── Header state ──────────────────────────────────────────────────────────
  const [voucherTypes,  setVoucherTypes]  = useState<VoucherType[]>([])
  const [activeType,    setActiveType]    = useState<VoucherType | null>(null)
  const [voucherDate,   setVoucherDate]   = useState(() => new Date().toISOString().slice(0, 10))
  const [refNumber,     setRefNumber]     = useState('')
  const [narration,     setNarration]     = useState(() => fromScanState?.prefill?.narration ?? '')
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

  // ── Entry rows ─────────────────────────────────────────────────────────────
  const [entries, setEntries] = useState<VoucherEntryRow[]>([emptyEntry(), emptyEntry()])

  // ── Submission ─────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false)

  // ── Invoice scan modal ────────────────────────────────────────────────────
  const [scanOpen, setScanOpen] = useState(false)

  // ── Staged attachments ────────────────────────────────────────────────────
  const [stagedFiles, setStagedFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // ── Preview ───────────────────────────────────────────────────────────────
  const [showPreview, setShowPreview] = useState(false)

  // ── GST Quick-Add panel ───────────────────────────────────────────────────
  const [taxLedgers,    setTaxLedgers]    = useState<TaxLedger[]>([])
  const [gstBase,       setGstBase]       = useState('')
  const [gstRateKey,    setGstRateKey]    = useState<'5' | '12' | '18' | '28' | 'custom'>('18')
  const [gstCustomRate, setGstCustomRate] = useState('')
  const [gstSupply,     setGstSupply]     = useState<'intra' | 'inter'>('intra')
  const [partyGstin,    setPartyGstin]    = useState<string | null>(null)

  // ── Init: voucher types are global — load once independently ───────────────
  useEffect(() => {
    fetchVoucherTypes()
      .then(types => {
        setVoucherTypes(types)
        // When arriving from an invoice scan, pre-select the matching voucher type
        const scanVoucherType = fromScanState?.prefill?.voucher_type?.toUpperCase()
        if (scanVoucherType && types.length > 0) {
          const match = types.find(t => t.code === scanVoucherType) ?? types[0]
          setActiveType(match)
        } else if (types.length > 0) {
          setActiveType(types.find(t => t.code === 'PYMT') ?? types[0])
        }
      })
      .catch(err => toast.error('Failed to load voucher types: ' + err.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Init: company-specific data — reload when active company changes ─────
  useEffect(() => {
    if (!companyId) return
    setLoadingInit(true)
    Promise.all([
      fetchCostCentres(companyId),
      fetchBankLedgers(companyId),
    ]).then(([centres, banks]) => {
      setCostCentres(centres)
      setBankLedgers(banks)
      setLoadingInit(false)
    }).catch(err => {
      toast.error(err.message)
      setLoadingInit(false)
    })
  }, [companyId])

  // ── Derived flags ─────────────────────────────────────────────────────────
  const needsEntity  = activeType ? NEEDS_ENTITY.has(activeType.nature)  : false
  const needsPayment    = activeType ? SHOWS_PAYMENT.has(activeType.nature) : false
  const requiresPayment = activeType ? NEEDS_PAYMENT.has(activeType.nature) : false
  const needsBank    = needsPayment && BANK_MODES.has(paymentMode)
  const needsUtr     = needsPayment && UTR_MODES.has(paymentMode)
  const needsCheque  = needsPayment && paymentMode === 'Cheque'

  // ── Entity search ─────────────────────────────────────────────────────────
  // PostgREST does not support ilike on embedded resource columns, so we do
  // two queries: (1) match entity names, (2) fetch their roles for this company.
  const searchEntities = useCallback(async (q: string) => {
    if (!q.trim() || !companyId) { setEntityOptions([]); return }
    setEntityLoading(true)
    try {
      type RawEntity = {
        id: string; display_name: string; mobile: string | null
        gstin: string | null
        upi_id: string | null; bank_name: string | null
        account_number: string | null; ifsc: string | null
      }
      type RawRole = { entity_id: string; role: string }

      // Step 1: find entities matching the query
      const { data: entities, error: eErr } = await supabase
        .schema('registry')
        .from('entities')
        .select('id, display_name, mobile, gstin, upi_id, bank_name, account_number, ifsc')
        .ilike('display_name', `%${q}%`)
        .limit(20)

      if (eErr || !entities?.length) { setEntityOptions([]); return }

      const entityIds = (entities as RawEntity[]).map(e => e.id)

      // Step 2: find which of those have a role in the active company
      const { data: roles } = await supabase
        .schema('registry')
        .from('entity_roles')
        .select('entity_id, role')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .in('role', ['Vendor', 'Supplier', 'Staff', 'Management', 'Contractor', 'Government', 'Auditor'])
        .in('entity_id', entityIds)

      if (!roles?.length) { setEntityOptions([]); return }

      // Merge
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
              gstin:          e.gstin,
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
    // Auto-detect intra vs inter-state from GSTIN state codes
    setPartyGstin(opt.gstin)
    if (opt.gstin && user?.activeCompany?.gstin) {
      const coState    = user.activeCompany.gstin.slice(0, 2)
      const partyState = opt.gstin.slice(0, 2)
      setGstSupply(coState === partyState ? 'intra' : 'inter')
    }
  }

  const clearEntity = () => { setEntityId(null); setEntityLabel(''); setPartyGstin(null) }

  // ── Entry row helpers ─────────────────────────────────────────────────────
  const updateEntry = (index: number, field: keyof VoucherEntryRow, value: string) => {
    setEntries(prev => prev.map((e, i) => i === index ? { ...e, [field]: value } : e))
  }

  // ── Load tax ledgers when switching to sales/purchase voucher type ─────────
  useEffect(() => {
    if (!companyId) return
    if (activeType?.nature !== 'sales' && activeType?.nature !== 'purchase') return
    fetchTaxLedgers(companyId).then(setTaxLedgers).catch(() => {})
  }, [companyId, activeType?.nature])

  // ── GST Quick-Add: compute and append entry rows ──────────────────────────
  const handleAddGSTEntries = () => {
    const base = parseFloat(gstBase)
    if (!base || base <= 0) { toast.error('Enter a valid taxable amount'); return }

    const rate = gstRateKey === 'custom' ? parseFloat(gstCustomRate) : parseFloat(gstRateKey)
    if (!rate || rate <= 0 || rate > 100) { toast.error('Enter a valid GST rate'); return }

    const isSales         = activeType?.nature === 'sales'
    const baseEntryType   = isSales ? 'Cr' : 'Dr'
    const newRows: VoucherEntryRow[] = []

    // Base income/expense row — ledger left blank; user picks from typeahead
    newRows.push({
      ledger_id: '', ledger_name: '', entry_type: baseEntryType,
      amount: base.toFixed(2),
      narration: isSales ? 'Sales (taxable value)' : 'Purchase (taxable value)',
    })

    if (gstSupply === 'intra') {
      const halfRate = rate / 2
      const taxAmt   = Math.round(base * halfRate) / 100
      const cgstL    = taxLedgers.find(l => l.tax_type === 'CGST')
      const sgstL    = taxLedgers.find(l => l.tax_type === 'SGST')
      newRows.push({
        ledger_id: cgstL?.id ?? '', ledger_name: cgstL?.name ?? '',
        entry_type: baseEntryType, amount: taxAmt.toFixed(2),
        narration: `CGST @ ${halfRate}%`,
      })
      newRows.push({
        ledger_id: sgstL?.id ?? '', ledger_name: sgstL?.name ?? '',
        entry_type: baseEntryType, amount: taxAmt.toFixed(2),
        narration: `SGST @ ${halfRate}%`,
      })
    } else {
      const igstAmt = Math.round(base * rate) / 100
      const igstL   = taxLedgers.find(l => l.tax_type === 'IGST')
      newRows.push({
        ledger_id: igstL?.id ?? '', ledger_name: igstL?.name ?? '',
        entry_type: baseEntryType, amount: igstAmt.toFixed(2),
        narration: `IGST @ ${rate}%`,
      })
    }

    setEntries(prev => [...prev, ...newRows])
    setGstBase('')
    const missing = newRows.filter(r => !r.ledger_id).length
    if (missing > 0)
      toast.warning(`${newRows.length - missing} rows added — ${missing} tax ledger(s) not found. Tag them in Ledgers → GST/Tax Ledger.`)
    else
      toast.success(`${newRows.length} entry rows added`)
  }

  const addEntry = () => setEntries(prev => [...prev, emptyEntry()])

  const removeEntry = (index: number) => {
    if (entries.length <= 2) { toast.error('Minimum 2 entry rows required'); return }
    setEntries(prev => prev.filter((_, i) => i !== index))
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const drTotal = entries.reduce((s, e) => e.entry_type === 'Dr' ? s + (parseFloat(e.amount) || 0) : s, 0)
  const crTotal = entries.reduce((s, e) => e.entry_type === 'Cr' ? s + (parseFloat(e.amount) || 0) : s, 0)
  const diff    = Math.abs(drTotal - crTotal)
  const balanced = drTotal > 0 && crTotal > 0 && Math.round(drTotal * 100) === Math.round(crTotal * 100)

  // ── Validation ────────────────────────────────────────────────────────────
  const validate = () => {
    if (!activeType)                              { toast.error('Select a voucher type');               return false }
    if (!voucherDate)                             { toast.error('Voucher date is required');            return false }
    if (needsEntity && !entityId)                 { toast.error('Party is required for this voucher type'); return false }
    if (requiresPayment && !paymentMode)           { toast.error('Payment mode is required');            return false }
    if (needsBank && !bankLedgerId)               { toast.error('Bank ledger is required');             return false }
    if (entries.length < 2)                       { toast.error('At least 2 entry rows required');      return false }
    if (entries.some(e => !e.ledger_id))          { toast.error('All entry rows must have a ledger');   return false }
    if (entries.some(e => !(parseFloat(e.amount) > 0))) { toast.error('All amounts must be greater than 0'); return false }
    if (!balanced)                                { toast.error('Voucher is unbalanced — Dr must equal Cr'); return false }
    return true
  }

  // ── Build payloads ────────────────────────────────────────────────────────
  const buildPayloads = () => {
    const entryPayloads = entries.map((e, i) => ({
      voucher_id:  '',
      ledger_id:   e.ledger_id,
      entry_type:  e.entry_type,
      amount:      parseFloat(e.amount),
      narration:   e.narration || null,
      sort_order:  i,
    }))

    const voucherBase = {
      company_id:          companyId,
      voucher_type_id:     activeType!.id,
      voucher_number:      'DRAFT',
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
      created_by:          userId,
    }

    return { voucherBase, entryPayloads }
  }

  // ── File helpers ──────────────────────────────────────────────────────────
  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? [])
    setStagedFiles(prev => {
      const existing = new Set(prev.map(f => f.name + f.size))
      return [...prev, ...picked.filter(f => !existing.has(f.name + f.size))]
    })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeStagedFile = (idx: number) =>
    setStagedFiles(prev => prev.filter((_, i) => i !== idx))

  // ── Save as draft ─────────────────────────────────────────────────────────
  const handleSaveDraft = async () => {
    if (!activeType || entries.some(e => !e.ledger_id)) {
      toast.error('Fill in at least the voucher type and ledgers before saving draft')
      return
    }
    setSaving(true)
    try {
      const { voucherBase, entryPayloads } = buildPayloads()
      await saveDraftVoucher({ ...voucherBase, status: 'draft' }, entryPayloads)
      toast.success('Draft saved')
      navigate('/vouchers')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save draft')
    } finally {
      setSaving(false)
    }
  }

  // ── Preview gate ──────────────────────────────────────────────────────────
  const handleSubmitClick = () => {
    if (!validate()) return
    setShowPreview(true)
  }

  // ── Confirm submit (from preview modal) ───────────────────────────────────
  const handleConfirmSubmit = async () => {
    setSaving(true)
    try {
      const { voucherBase, entryPayloads } = buildPayloads()
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { voucher_number: _vn, ...base } = voucherBase
      const voucherId = await submitVoucher(base, entryPayloads, companyCode, activeType!.prefix)
      if (stagedFiles.length > 0) {
        const { failed } = await uploadVoucherAttachments(voucherId, companyId, userId, stagedFiles)
        if (failed.length > 0) toast.warning(`Voucher saved — ${failed.length} file(s) failed to upload`)
      }
      toast.success('Voucher submitted for approval')
      navigate('/vouchers')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit voucher')
    } finally {
      setSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (loadingInit) {
    return (
      <div className={styles.loadingPage}>
        <Loader2 size={24} className={styles.spin} />
      </div>
    )
  }

  const isPayment = activeType?.nature === 'payment'
  const isReceipt  = activeType?.nature === 'receipt'
  const useSimplifiedForm = isPayment || isReceipt

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>New Voucher</h1>
        <button
          type="button"
          className={styles.scanBtn ?? ''}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
            background: 'var(--surface)', border: '1px solid var(--border-2)',
            borderRadius: '8px', padding: '0.4375rem 0.875rem',
            fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
            color: 'var(--text)', fontFamily: 'inherit',
          }}
          onClick={() => setScanOpen(true)}
        >
          <ScanLine size={15} /> Scan Invoice
        </button>
      </div>

      <InvoiceScanModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        companyId={companyId}
        companyCode={companyCode}
        companyGstin={user?.activeCompany?.gstin ?? ''}
        companyName={user?.activeCompany?.name ?? ''}
        userId={userId}
        voucherTypes={voucherTypes}
      />

      {/* ── fromScan banner ────────────────────────────────────────────── */}
      {fromScanState?.fromScan && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.625rem',
          padding: '0.75rem 1rem', marginBottom: '1rem',
          background: 'rgba(74,158,158,0.08)', border: '1px solid rgba(74,158,158,0.25)',
          borderRadius: '8px', fontSize: '0.875rem', color: 'var(--teal)',
        }}>
          <ScanLine size={15} style={{ flexShrink: 0 }} />
          <span>
            Pre-filled from invoice scan.
            {fromScanState.prefill?.party_name && (
              <> Party: <strong>{fromScanState.prefill.party_name}</strong>.</>
            )}
            {' '}Narration and amount pre-populated — review entries before submitting.
          </span>
        </div>
      )}

      {/* ── Type selector — always visible ─────────────────────────────── */}
      <div className={styles.section} style={{ maxWidth: useSimplifiedForm ? 640 : undefined }}>
        <div className={styles.segmented}>
          {voucherTypes.map(vt => (
            <button
              key={vt.id}
              type="button"
              className={`${styles.seg} ${activeType?.id === vt.id ? styles.segActive : ''}`}
              onClick={() => { setActiveType(vt); setPaymentMode(''); setEntries([emptyEntry(), emptyEntry()]) }}
            >
              {vt.name}
            </button>
          ))}
        </div>
      </div>

      {/* ── Date — always visible ──────────────────────────────────────── */}
      <div style={{ maxWidth: useSimplifiedForm ? 640 : undefined, marginBottom: '0.25rem' }}>
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

      {/* ── Payment / Receipt → simplified conversational form ───────── */}
      {useSimplifiedForm && activeType ? (
        <SimplifiedPaymentEntry
          key={activeType.id}
          companyId={companyId}
          companyCode={companyCode}
          userId={userId}
          voucherType={activeType}
          voucherDate={voucherDate}
        />
      ) : (

      /* ── All other types → advanced two-column form ────────────────── */
      <div className={styles.layout}>
        {/* ── LEFT COLUMN: Header fields ─────────────────────────────────── */}
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

          {/* Entity (Party) — only for Receipt */}
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

          {/* Payment Mode / Received Via */}
          {needsPayment && (
            <div className={styles.field}>
              <label className={styles.label}>
                {activeType?.nature === 'receipt' ? 'Received Via' : 'Payment Mode'}
                {requiresPayment
                  ? <span className={styles.req}> *</span>
                  : <span style={{ fontWeight: 400, opacity: 0.6 }}> (optional — blank = credit)</span>}
              </label>
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
                  <AlertTriangle size={13} /> No bank accounts set up yet. Add one in Ledgers first.
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

          {/* Attachments */}
          <div className={styles.field}>
            <label className={styles.label}>Attachments <span className={styles.labelOpt}>(optional)</span></label>
            <div
              className={styles.attachZone}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault()
                const dropped = Array.from(e.dataTransfer.files)
                setStagedFiles(prev => {
                  const existing = new Set(prev.map(f => f.name + f.size))
                  return [...prev, ...dropped.filter(f => !existing.has(f.name + f.size))]
                })
              }}
            >
              <Paperclip size={15} className={styles.attachZoneIcon} />
              <span>Tap to attach invoices, receipts or PDFs</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              capture="environment"
              style={{ display: 'none' }}
              onChange={handleFilePick}
            />
            {stagedFiles.length > 0 && (
              <div className={styles.stagedList}>
                {stagedFiles.map((file, idx) => (
                  <div key={idx} className={styles.stagedItem}>
                    <FileText size={13} className={styles.stagedIcon} />
                    <span className={styles.stagedName}>{file.name}</span>
                    <span className={styles.stagedSize}>{formatFileSize(file.size)}</span>
                    <button
                      type="button"
                      className={styles.stagedRemove}
                      onClick={() => removeStagedFile(idx)}
                      aria-label="Remove"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT COLUMN: Entry rows ────────────────────────────────────── */}
        <div className={styles.rightCol}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionLabel}>Accounting Entries</span>
          </div>

          {/* ── GST Quick-Add panel (sales / purchase only) ─────────────────── */}
          {(activeType?.nature === 'sales' || activeType?.nature === 'purchase') && (
            <div className={styles.gstPanel}>
              <div className={styles.gstPanelHeader}>
                ⚡ GST Quick-Add
                {taxLedgers.length === 0 && (
                  <span className={styles.gstPanelHint}>
                    — tag GST ledgers in Ledgers → GST/Tax Ledger to enable auto-fill
                  </span>
                )}
              </div>
              <div className={styles.gstPanelBody}>
                <div className={styles.gstPanelRow}>
                  {/* Taxable amount */}
                  <div className={styles.field} style={{ minWidth: 130, flex: '0 0 auto' }}>
                    <label className={styles.label}>Taxable Amount</label>
                    <input
                      className={styles.input}
                      type="number"
                      step="0.01"
                      min="0"
                      value={gstBase}
                      onChange={e => setGstBase(e.target.value)}
                      placeholder="0.00"
                    />
                  </div>
                  {/* GST Rate */}
                  <div className={styles.field} style={{ flex: '1 1 auto' }}>
                    <label className={styles.label}>GST Rate</label>
                    <div className={styles.modeGrid}>
                      {(['5', '12', '18', '28'] as const).map(r => (
                        <button
                          key={r}
                          type="button"
                          className={`${styles.modeBtn} ${gstRateKey === r ? styles.modeBtnActive : ''}`}
                          onClick={() => setGstRateKey(r)}
                        >{r}%</button>
                      ))}
                      <button
                        type="button"
                        className={`${styles.modeBtn} ${gstRateKey === 'custom' ? styles.modeBtnActive : ''}`}
                        onClick={() => setGstRateKey('custom')}
                      >Custom</button>
                    </div>
                    {gstRateKey === 'custom' && (
                      <input
                        className={styles.input}
                        style={{ marginTop: '0.375rem', maxWidth: 100 }}
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        value={gstCustomRate}
                        onChange={e => setGstCustomRate(e.target.value)}
                        placeholder="Rate %"
                      />
                    )}
                  </div>
                </div>
                {/* Supply type */}
                <div className={styles.field}>
                  <label className={styles.label}>
                    Supply Type
                    {partyGstin && (
                      <span className={styles.gstPanelHint}> — auto-detected from party GSTIN</span>
                    )}
                  </label>
                  <div className={styles.modeGrid}>
                    <button
                      type="button"
                      className={`${styles.modeBtn} ${gstSupply === 'intra' ? styles.modeBtnActive : ''}`}
                      onClick={() => setGstSupply('intra')}
                    >Intra-state (CGST + SGST)</button>
                    <button
                      type="button"
                      className={`${styles.modeBtn} ${gstSupply === 'inter' ? styles.modeBtnActive : ''}`}
                      onClick={() => setGstSupply('inter')}
                    >Inter-state (IGST)</button>
                  </div>
                </div>
                <button
                  type="button"
                  className={styles.addRowBtn}
                  onClick={handleAddGSTEntries}
                  disabled={!gstBase || parseFloat(gstBase) <= 0}
                >
                  <Plus size={14} /> Add GST Entry Rows
                </button>
              </div>
            </div>
          )}

          {/* Entry rows */}
          <div className={styles.entriesTable}>
            {/* Header */}
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
              onClick={handleSubmitClick}
              disabled={saving || !balanced}
              title={!balanced ? 'Voucher must be balanced before submitting' : ''}
            >
              <Check size={14} /> Review &amp; Submit
            </button>
          </div>
        </div>
      </div>
      )}

      {/* ── Preview modal ─────────────────────────────────────────────────── */}
      {showPreview && (
        <div className={styles.previewBackdrop} onClick={() => setShowPreview(false)}>
          <div className={styles.previewModal} onClick={e => e.stopPropagation()}>
            <div className={styles.previewHeader}>
              <h3 className={styles.previewTitle}>Review — {activeType?.name} Voucher</h3>
              <button type="button" className={styles.previewClose} onClick={() => setShowPreview(false)}>
                <X size={16} />
              </button>
            </div>
            <div className={styles.previewBody}>
              <div className={styles.previewMeta}>
                <div><span className={styles.previewKey}>Date</span>{voucherDate}</div>
                {refNumber && <div><span className={styles.previewKey}>Reference</span>{refNumber}</div>}
                {entityId && <div><span className={styles.previewKey}>Party</span>{entityLabel}</div>}
                {needsPayment && paymentMode && <div><span className={styles.previewKey}>Mode</span>{paymentMode}</div>}
                {narration && <div className={styles.previewMetaFull}><span className={styles.previewKey}>Narration</span>{narration}</div>}
              </div>
              <div>
                <div className={styles.previewSectionTitle}>Accounting Entries</div>
                <table className={styles.previewTable}>
                  <thead>
                    <tr>
                      <th>Ledger</th>
                      <th className={styles.previewRight}>Dr (₹)</th>
                      <th className={styles.previewRight}>Cr (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e, i) => (
                      <tr key={i}>
                        <td>{e.ledger_name}</td>
                        <td className={styles.previewRight}>{e.entry_type === 'Dr' ? formatIndianCurrency(parseFloat(e.amount)) : ''}</td>
                        <td className={styles.previewRight}>{e.entry_type === 'Cr' ? formatIndianCurrency(parseFloat(e.amount)) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td><strong>Total</strong></td>
                      <td className={styles.previewRight}><strong>{formatIndianCurrency(drTotal)}</strong></td>
                      <td className={styles.previewRight}><strong>{formatIndianCurrency(crTotal)}</strong></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {stagedFiles.length > 0 && (
                <div>
                  <div className={styles.previewSectionTitle}>Attachments ({stagedFiles.length})</div>
                  <div className={styles.previewAttachList}>
                    {stagedFiles.map((f, i) => (
                      <div key={i} className={styles.previewAttachItem}>
                        <FileText size={12} />
                        <span>{f.name}</span>
                        <span className={styles.previewAttachSize}>{formatFileSize(f.size)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className={styles.previewFooter}>
              <button type="button" className={styles.btnDraft} onClick={() => setShowPreview(false)}>
                ← Back to Edit
              </button>
              <button
                type="button"
                className={styles.btnSubmit}
                onClick={handleConfirmSubmit}
                disabled={saving}
              >
                {saving ? <Loader2 size={14} className={styles.spin} /> : <Check size={14} />}
                {saving ? 'Submitting…' : 'Confirm & Submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Entry Row sub-component ───────────────────────────────────────────────────

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
