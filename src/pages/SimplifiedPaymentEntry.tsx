import { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, Trash2, Check, X, Loader2, Search, Eye, EyeOff, Paperclip, FileText, Image as ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'
import {
  submitVoucher,
  searchLedgers,
  formatIndianCurrency,
  fetchPaymentAccounts,
  fetchEntityLedger,
  type VoucherType,
  type PaymentAccount,
} from '@/lib/vouchers'
import {
  uploadVoucherAttachments,
  isImage,
  formatFileSize,
} from '@/lib/attachments'
import { supabase } from '@/lib/supabase'
import { fetchOpenBills, saveAllocations, type OpenBill, type AllocRow } from '@/lib/allocations'
import BillAllocPanel from '@/components/BillAllocPanel'
import QRRelayModal from '@/components/QRRelayModal'
import styles from './SimplifiedPaymentEntry.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface EntityOption {
  entity_id:    string
  display_name: string
  mobile:       string | null
  role:         string
}

interface ExpenseLine {
  key:        string
  ledger_id:  string
  ledger_name: string
  amount:     string
}

interface Props {
  companyId:         string
  companyCode:       string
  userId:            string
  voucherType:       VoucherType
  voucherDate:       string
  // The paired voucher type used in the "New invoice — enter it now" flow:
  // payment → purchase type; receipt → sales type
  // null means the paired type wasn't found (button is hidden).
  pairedVoucherType: VoucherType | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2) }

const UTR_MODES = new Set(['UPI', 'NEFT', 'RTGS', 'IMPS'])

// ── Main component ────────────────────────────────────────────────────────────

export default function SimplifiedPaymentEntry({
  companyId, companyCode, userId, voucherType, voucherDate, pairedVoucherType,
}: Props) {
  const navigate = useNavigate()

  // ── Step 1: Who ───────────────────────────────────────────────────────────
  const [entitySkipped,  setEntitySkipped]  = useState(false)
  const [entityId,       setEntityId]       = useState<string | null>(null)
  const [entityLabel,    setEntityLabel]    = useState('')
  const [entitySearch,   setEntitySearch]   = useState('')
  const [entityOptions,  setEntityOptions]  = useState<EntityOption[]>([])
  const [entityLoading,  setEntityLoading]  = useState(false)
  const entityTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Step 2: Total amount ──────────────────────────────────────────────────
  const [totalAmount, setTotalAmount] = useState('')
  // step2Committed prevents Step 3 from appearing (and stealing focus) while
  // the user is still typing in the amount field.
  const [step2Committed, setStep2Committed] = useState(false)

  // ── Step 3: Expense lines ─────────────────────────────────────────────────
  const [lines, setLines] = useState<ExpenseLine[]>([
    { key: uid(), ledger_id: '', ledger_name: '', amount: '' },
  ])

  // ── Step 4: Payment account ───────────────────────────────────────────────
  const [paymentAccounts,   setPaymentAccounts]   = useState<PaymentAccount[]>([])
  const [accountsLoading,   setAccountsLoading]   = useState(false)
  const [selectedAccountId, setSelectedAccountId] = useState('')

  // ── Auto-scroll refs for each step ───────────────────────────────────────
  const step3Ref = useRef<HTMLDivElement>(null)
  const step4Ref = useRef<HTMLDivElement>(null)
  const step5Ref = useRef<HTMLDivElement>(null)
  const step6Ref = useRef<HTMLDivElement>(null)
  const step8Ref = useRef<HTMLDivElement>(null)

  // ── Step 5: Payment mode ──────────────────────────────────────────────────
  const [paymentMode,  setPaymentMode]  = useState('')
  const [utrNumber,    setUtrNumber]    = useState('')
  const [chequeNumber, setChequeNumber] = useState('')
  const [chequeDate,   setChequeDate]   = useState('')

  // ── Step 6: Reference ─────────────────────────────────────────────────────
  const [refNumber, setRefNumber] = useState('')
  const [narration, setNarration] = useState('')

  // ── Bill allocation (between step 1 and step 2) ───────────────────────────
  const [openBills,        setOpenBills]        = useState<OpenBill[]>([])
  const [openBillsLoading, setOpenBillsLoading] = useState(false)
  const [openBillsLoaded,  setOpenBillsLoaded]  = useState(false)
  const [billAllocs,       setBillAllocs]       = useState<AllocRow[]>([])
  const [billStepSkipped,  setBillStepSkipped]  = useState(false)
  const [billStepDone,     setBillStepDone]     = useState(false)
  // 'expense' = hits P&L immediately (salary, rent, wages)
  // 'advance' = sits on Balance Sheet until settled (travel advance, deposit)
  const [directPaymentType, setDirectPaymentType] = useState<'expense' | 'advance' | null>(null)
  // 'new_invoice' = atomically create Purchase+Payment via create_linked_vouchers RPC
  const [newInvoiceMode,    setNewInvoiceMode]    = useState(false)
  const [entityLedgerId,    setEntityLedgerId]    = useState<string | null>(null)
  const [entityLedgerName,  setEntityLedgerName]  = useState('')
  const step2BillRef = useRef<HTMLDivElement>(null)

  // ── Step 7: Attachments ──────────────────────────────────────────────────
  const [stagedFiles,  setStagedFiles]  = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── UI ────────────────────────────────────────────────────────────────────
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [showPreview,  setShowPreview]  = useState(false)

  // ── Fetch payment accounts ────────────────────────────────────────────────
  useEffect(() => {
    if (!companyId) return
    setAccountsLoading(true)
    fetchPaymentAccounts(companyId)
      .then(setPaymentAccounts)
      .catch(err => toast.error(err.message))
      .finally(() => setAccountsLoading(false))
  }, [companyId])

  // ── Bill allocation derived flags ─────────────────────────────────────────
  const billNature: 'purchase' | 'sales' | null =
    voucherType.nature === 'payment' ? 'purchase' :
    voucherType.nature === 'receipt' ? 'sales' : null
  const showBillStep    = !!(entityId && billNature)
  // Step is complete only when: bills allocated, OR user has explicitly chosen expense/advance,
  // OR new invoice mode is active (actual construction happens at submit time)
  // (billStepSkipped alone is insufficient — the choice card must be answered first)
  const billStepComplete = !showBillStep || billStepDone
    || (billStepSkipped && directPaymentType !== null)
    || newInvoiceMode

  // When advance is selected, load entity ledger (needed for the Cr/Dr party entry)
  useEffect(() => {
    if (directPaymentType === 'advance' && entityId && companyId && !entityLedgerId) {
      fetchEntityLedger(companyId, entityId)
        .then(ledger => {
          if (ledger) { setEntityLedgerId(ledger.id); setEntityLedgerName(ledger.name) }
        })
        .catch(() => { /* handled at submit */ })
    }
  }, [directPaymentType, entityId, companyId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load open bills when entity is selected for payment/receipt ───────────
  // (effect runs on entityId + billNature changes; clearEntity resets state)

  // Advance mode: Step 3 (income/expense ledger) is skipped
  const isAdvanceMode = directPaymentType === 'advance'

  // ── Derived step completion ───────────────────────────────────────────────
  const step1Done = entityId !== null || entitySkipped
  const totalNum  = parseFloat(totalAmount) || 0
  const step2Done = totalNum > 0
  const linesSum     = lines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0)
  const linesOk      = lines.every(l => l.ledger_id && parseFloat(l.amount) > 0)
  // Advance bypasses the ledger lines entirely
  const step3Done    = isAdvanceMode
    ? step2Done && !!entityLedgerId
    : step2Done && linesOk && Math.round(linesSum * 100) === Math.round(totalNum * 100)

  const selectedAccount = paymentAccounts.find(a => a.id === selectedAccountId) ?? null
  const isBankAccount   = selectedAccount?.type === 'bank'
  const step4Done       = !!selectedAccountId
  const step5Done       = !isBankAccount || !!paymentMode  // cash = no mode choice needed

  // ── Step visibility ───────────────────────────────────────────────────────
  const show2     = step1Done && billStepComplete
  // Step 3 hidden for advance — party is already known from entity ledger
  const show3     = show2 && step2Done && step2Committed && !isAdvanceMode
  const show4     = show3 && step3Done
  const show5     = show4 && step4Done && isBankAccount
  const show6     = show4 && step4Done && (!isBankAccount || step5Done)
  const show7     = show6
  const canSubmit = step3Done && step4Done && step5Done

  // ── Auto-reset payment mode when account changes ──────────────────────────
  useEffect(() => {
    if (selectedAccount?.type === 'cash') setPaymentMode('cash')
    else setPaymentMode('')
  }, [selectedAccountId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-scroll to newly revealed steps ───────────────────────────────────
  useEffect(() => {
    if (showBillStep) step2BillRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [showBillStep]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!entityId || !billNature || !companyId) {
      setOpenBills([])
      setOpenBillsLoaded(false)
      setBillAllocs([])
      setBillStepDone(false)
      setBillStepSkipped(false)
      setDirectPaymentType(null)
      setNewInvoiceMode(false)
      setEntityLedgerId(null)
      setEntityLedgerName('')
      return
    }
    setOpenBillsLoading(true)
    setOpenBillsLoaded(false)
    fetchOpenBills(companyId, entityId, billNature)
      .then(bills => {
        setOpenBills(bills)
        setOpenBillsLoaded(true)
        // No auto-skip when bills.length === 0 — user must explicitly choose
        // "Direct expense" or "Advance" via the intent card below.
      })
      .catch(() => { setOpenBillsLoaded(true); setBillStepSkipped(true); setDirectPaymentType(null) })
      .finally(() => setOpenBillsLoading(false))
  }, [entityId, billNature, companyId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (show3) step3Ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [show3])
  useEffect(() => { if (show4) step4Ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [show4])
  useEffect(() => { if (show5) step5Ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [show5])
  useEffect(() => { if (show6) step6Ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [show6])
  useEffect(() => { if (canSubmit) step8Ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [canSubmit])
  useEffect(() => { if (!canSubmit) setShowPreview(false) }, [canSubmit])

  // ── Entity search ─────────────────────────────────────────────────────────
  const searchEntities = useCallback(async (q: string) => {
    if (!q.trim() || !companyId) { setEntityOptions([]); return }
    setEntityLoading(true)
    try {
      type RawEntity = { id: string; display_name: string; mobile: string | null }
      type RawRole   = { entity_id: string; role: string }

      const { data: entities, error: eErr } = await supabase
        .schema('registry')
        .from('entities')
        .select('id, display_name, mobile')
        .ilike('display_name', `%${q}%`)
        .limit(20)

      if (eErr || !entities?.length) { setEntityOptions([]); return }

      const ids = (entities as RawEntity[]).map(e => e.id)

      // Role filter is context-aware: receipts come FROM customers;
      // payments go TO vendors/staff. Vendors are included in receipt
      // roles to cover refund scenarios (vendor returning money).
      const roleFilter = voucherType.nature === 'receipt'
        ? ['Customer', 'Vendor', 'Supplier']
        : ['Vendor', 'Supplier', 'Staff', 'Management', 'Contractor', 'Government', 'Auditor', 'Fisher']

      const { data: roles } = await supabase
        .schema('registry')
        .from('entity_roles')
        .select('entity_id, role')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .in('role', roleFilter)
        .in('entity_id', ids)

      if (!roles?.length) { setEntityOptions([]); return }

      const map = new Map((entities as RawEntity[]).map(e => [e.id, e]))
      // Deduplicate by entity_id — an entity may have roles in multiple companies;
      // show each entity only once (first matching role).
      const seen = new Set<string>()
      setEntityOptions(
        (roles as RawRole[])
          .filter(r => map.has(r.entity_id) && !seen.has(r.entity_id) && seen.add(r.entity_id) !== undefined)
          .slice(0, 8)
          .map(r => {
            const e = map.get(r.entity_id)!
            return { entity_id: r.entity_id, display_name: e.display_name, mobile: e.mobile, role: r.role }
          })
      )
    } finally { setEntityLoading(false) }
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
    setEntitySkipped(false)
    // Reset bill state when entity changes
    setBillAllocs([])
    setBillStepDone(false)
    setBillStepSkipped(false)
    setDirectPaymentType(null)
    setNewInvoiceMode(false)
    setEntityLedgerId(null)
    setEntityLedgerName('')
  }

  const clearEntity = () => {
    setEntityId(null)
    setEntityLabel('')
    setEntitySkipped(false)
    setOpenBills([])
    setOpenBillsLoaded(false)
    setBillAllocs([])
    setBillStepDone(false)
    setBillStepSkipped(false)
    setDirectPaymentType(null)
    setNewInvoiceMode(false)
    setEntityLedgerId(null)
    setEntityLedgerName('')
  }

  // ── Expense line helpers ──────────────────────────────────────────────────
  const updateLine = (key: string, field: keyof Omit<ExpenseLine, 'key'>, val: string) =>
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: val } : l))

  const addLine = () =>
    setLines(prev => [...prev, { key: uid(), ledger_id: '', ledger_name: '', amount: '' }])

  const removeLine = (key: string) => {
    if (lines.length <= 1) return
    setLines(prev => prev.filter(l => l.key !== key))
  }

  // Keep single line amount always in sync with total amount.
  // (The per-line amount input is hidden when there's only one line.)
  const handleTotalChange = (val: string) => {
    setTotalAmount(val)
    setStep2Committed(false)   // reset commitment so Step 3 doesn't re-appear mid-edit
    if (lines.length === 1) {
      setLines(prev => prev.map((l, i) => i === 0 ? { ...l, amount: val } : l))
    }
  }

  const commitStep2 = () => {
    if (totalNum > 0) setStep2Committed(true)
  }

  // ── Balance / ledger hint message ──────────────────────────────────────
  const anyLineMissingLedger = lines.some(l => !l.ledger_id)
  const remaining   = totalNum - linesSum
  const balanceHint: string | null = step2Done && !step3Done && !isAdvanceMode
    ? anyLineMissingLedger
      ? 'Type an expense name above and select it from the dropdown to continue'
      : remaining > 0
        ? `Add ${formatIndianCurrency(remaining)} more to the expense items to balance`
        : remaining < 0
          ? `Remove ${formatIndianCurrency(Math.abs(remaining))} — items exceed the total`
          : null
    : null

  // ── Build Dr/Cr entries ───────────────────────────────────────────────────
  // Direction depends on voucher type + mode:
  //   advance receipt:  Dr bank / Cr party ledger   (no income line)
  //   advance payment:  Dr party ledger / Cr bank   (no expense line)
  //   normal receipt:   Dr bank / Cr income lines
  //   normal payment:   Dr expense lines / Cr bank
  const isReceiptMode = voucherType.nature === 'receipt'
  const buildEntries = () => {
    if (isAdvanceMode && entityLedgerId) {
      return isReceiptMode
        ? [
            { voucher_id: '', ledger_id: selectedAccountId, entry_type: 'Dr' as const, amount: totalNum, narration: null, sort_order: 0 },
            { voucher_id: '', ledger_id: entityLedgerId,    entry_type: 'Cr' as const, amount: totalNum, narration: null, sort_order: 1 },
          ]
        : [
            { voucher_id: '', ledger_id: entityLedgerId,    entry_type: 'Dr' as const, amount: totalNum, narration: null, sort_order: 0 },
            { voucher_id: '', ledger_id: selectedAccountId, entry_type: 'Cr' as const, amount: totalNum, narration: null, sort_order: 1 },
          ]
    }
    return isReceiptMode
    ? [
        // Receipt: money comes IN — bank is debited, income ledgers credited
        {
          voucher_id: '', ledger_id: selectedAccountId,
          entry_type: 'Dr' as const, amount: totalNum,
          narration: null, sort_order: 0,
        },
        ...lines.map((l, i) => ({
          voucher_id: '', ledger_id: l.ledger_id,
          entry_type: 'Cr' as const, amount: parseFloat(l.amount),
          narration: null, sort_order: i + 1,
        })),
      ]
    : [
        // Payment: money goes OUT — expense ledgers debited, bank credited
        ...lines.map((l, i) => ({
          voucher_id: '', ledger_id: l.ledger_id,
          entry_type: 'Dr' as const, amount: parseFloat(l.amount),
          narration: null, sort_order: i,
        })),
        {
          voucher_id: '', ledger_id: selectedAccountId,
          entry_type: 'Cr' as const, amount: totalNum,
          narration: null, sort_order: lines.length,
        },
      ]
  }

  // ── New invoice handler — loads entity ledger in background ──────────────
  const handleNewInvoiceIntent = async () => {
    if (!entityId || !pairedVoucherType) return
    setNewInvoiceMode(true)
    setBillStepSkipped(true)
    // Background-load entity ledger so we can validate at submit time without blocking UX
    fetchEntityLedger(companyId, entityId)
      .then(ledger => {
        if (ledger) { setEntityLedgerId(ledger.id); setEntityLedgerName(ledger.name) }
      })
      .catch(() => { /* handled at submit time */ })
  }

  // ── File staging helpers ──────────────────────────────────────────────────
  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? [])
    setStagedFiles(prev => {
      const existing = new Set(prev.map(f => f.name + f.size))
      const fresh = picked.filter(f => !existing.has(f.name + f.size))
      return [...prev, ...fresh]
    })
    // reset input so same file can be re-added after removal
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeStagedFile = (idx: number) =>
    setStagedFiles(prev => prev.filter((_, i) => i !== idx))

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!canSubmit) return
    setSaving(true)
    try {
      const finalMode   = isBankAccount ? paymentMode.toLowerCase() : 'cash'
      const needsUtr    = UTR_MODES.has(paymentMode)
      const needsCheque = paymentMode === 'Cheque'

      // ── Path A: New invoice — atomic Purchase+Payment via RPC ────────────────────
      if (newInvoiceMode) {
        if (!pairedVoucherType) {
          toast.error('Paired voucher type not found — cannot create linked vouchers')
          return
        }
        if (!entityLedgerId) {
          toast.error(
            `No ledger found for this ${isReceiptMode ? 'customer' : 'vendor'}. ` +
            'Go to Ledgers → New Ledger and link it to this entity before using this option.'
          )
          return
        }
        // Build balanced entries for both vouchers:
        // Bill (Purchase/Sales): Dr expense/income lines + Cr/Dr entity ledger
        // Payment/Receipt:       Dr entity ledger + Cr/Dr bank account
        const billEntries = isReceiptMode
          ? [
              // Sales: Dr entity debtor ledger / Cr income lines
              { ledger_id: entityLedgerId, entry_type: 'Dr', amount: totalNum, narration: null, sort_order: 0 },
              ...lines.map((l, i) => ({ ledger_id: l.ledger_id, entry_type: 'Cr', amount: parseFloat(l.amount), narration: null, sort_order: i + 1 })),
            ]
          : [
              // Purchase: Dr expense lines / Cr entity creditor ledger
              ...lines.map((l, i) => ({ ledger_id: l.ledger_id, entry_type: 'Dr', amount: parseFloat(l.amount), narration: null, sort_order: i })),
              { ledger_id: entityLedgerId, entry_type: 'Cr', amount: totalNum, narration: null, sort_order: lines.length },
            ]

        const payEntries = isReceiptMode
          ? [
              // Receipt: Dr bank / Cr entity debtor ledger
              { ledger_id: selectedAccountId, entry_type: 'Dr', amount: totalNum, narration: null, sort_order: 0 },
              { ledger_id: entityLedgerId,    entry_type: 'Cr', amount: totalNum, narration: null, sort_order: 1 },
            ]
          : [
              // Payment: Dr entity creditor ledger / Cr bank
              { ledger_id: entityLedgerId,    entry_type: 'Dr', amount: totalNum, narration: null, sort_order: 0 },
              { ledger_id: selectedAccountId, entry_type: 'Cr', amount: totalNum, narration: null, sort_order: 1 },
            ]

        const billPayload = {
          company_id: companyId, company_code: companyCode,
          prefix: pairedVoucherType.prefix,
          voucher_type_id: pairedVoucherType.id,
          voucher_date: voucherDate,
          entity_id: entityId,
          amount: totalNum,
          narration: narration || null,
          ref_document_number: refNumber || null,
          created_by: userId,
        }
        const payPayload = {
          company_id: companyId, company_code: companyCode,
          prefix: voucherType.prefix,
          voucher_type_id: voucherType.id,
          voucher_date: voucherDate,
          entity_id: entityId,
          amount: totalNum,
          payment_mode: finalMode || null,
          bank_ledger_id: isBankAccount ? selectedAccountId : null,
          cheque_number: needsCheque ? chequeNumber || null : null,
          cheque_date: needsCheque ? chequeDate || null : null,
          utr_number: needsUtr ? utrNumber || null : null,
          narration: narration || null,
          ref_document_number: refNumber || null,
          created_by: userId,
        }

        const { data: rpcResult, error: rpcError } = await supabase
          .schema('pramaana')
          .rpc('create_linked_vouchers', {
            p_purchase:         billPayload,
            p_purchase_entries: billEntries,
            p_payment:          payPayload,
            p_payment_entries:  payEntries,
          })

        if (rpcError) throw new Error(rpcError.message)

        const ids = rpcResult as {
          purchase_id: string; purchase_number: string
          payment_id:  string; payment_number:  string
        }

        if (stagedFiles.length > 0) {
          const { failed } = await uploadVoucherAttachments(ids.payment_id, companyId, userId, stagedFiles)
          if (failed.length > 0)
            toast.warning(`Submitted — ${failed.length} file(s) failed to upload`)
        }

        toast.success(
          `${isReceiptMode ? 'Sales + receipt' : 'Purchase + payment'} submitted — ` +
          `${ids.purchase_number} & ${ids.payment_number}`
        )
        navigate('/vouchers')
        return
      }

      // ── Path B: Normal single-voucher submit ────────────────────────────────
      const entries = buildEntries()

      const payload = {
        company_id:          companyId,
        voucher_type_id:     voucherType.id,
        voucher_date:        voucherDate,
        narration:           narration || null,
        entity_id:           entityId,
        amount:              totalNum,
        payment_mode:        finalMode || null,
        bank_ledger_id:      isBankAccount ? selectedAccountId : null,
        cheque_number:       needsCheque ? chequeNumber || null : null,
        cheque_date:         needsCheque ? chequeDate || null : null,
        utr_number:          needsUtr ? utrNumber || null : null,
        cost_centre_id:      null,
        ref_document_number: refNumber || null,
        created_by:          userId,
      }

      // Create the voucher first (so we have an ID to attach files to)
      const voucherId = await submitVoucher(payload, entries, companyCode, voucherType.prefix)

      // Save bill allocations (fire-and-forget — don't fail the submission)
      if (billAllocs.length > 0) {
        saveAllocations(companyId, entityId, voucherId, userId, billAllocs)
          .catch(err => toast.warning('Voucher saved — bill allocations not recorded: ' + (err as Error).message))
      }

      // Upload staged files (non-blocking failures)
      if (stagedFiles.length > 0) {
        const { failed } = await uploadVoucherAttachments(voucherId, companyId, userId, stagedFiles)
        if (failed.length > 0) {
          toast.warning(`Voucher saved — ${failed.length} file(s) failed to upload: ${failed.join(', ')}`)
        }
      }

      toast.success('Voucher submitted for approval')
      navigate('/vouchers')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit voucher')
    } finally {
      setSaving(false)
    }
  }

  // ── Advanced entries for review panel ────────────────────────────────────
  const advEntries   = step3Done && step4Done ? buildEntries() : []
  const ledgerLabel  = new Map([
    ...lines.map(l => [l.ledger_id, l.ledger_name] as [string, string]),
    [selectedAccountId, selectedAccount?.name ?? ''],
  ])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.form}>

      {/* ════ Step 1 — Who ════════════════════════════════════════════════ */}
      <div className={styles.step}>
        <StepHead num={1} done={step1Done} label={
          voucherType.nature === 'receipt' ? 'Who is paying you?' : 'Who are you paying?'
        } />
        <div className={styles.body}>
          {entityId ? (
            <div className={styles.selectedChip}>
              <span>{entityLabel}</span>
              <button type="button" onClick={clearEntity} aria-label="Remove"><X size={13} /></button>
            </div>
          ) : entitySkipped ? (
            <div className={styles.skippedChip}>
              <span>No party specified</span>
              <button type="button" onClick={() => setEntitySkipped(false)} aria-label="Remove"><X size={13} /></button>
            </div>
          ) : (
            <div className={styles.entityRow}>
              <div className={styles.typeahead}>
                <Search size={14} className={styles.searchIcon} />
                <input
                  className={styles.typeaheadInput}
                  value={entitySearch}
                  onChange={e => handleEntityInput(e.target.value)}
                  placeholder={voucherType.nature === 'receipt'
                    ? 'Search customers…'
                    : 'Search vendors, staff, contractors…'
                  }
                  autoFocus
                />
                {entityLoading && <Loader2 size={14} className={`${styles.spin} ${styles.searchSpinner}`} />}
                {entityOptions.length > 0 && (
                  <ul className={styles.dropdown}>
                    {entityOptions.map(opt => (
                      <li key={opt.entity_id} onMouseDown={() => selectEntity(opt)}>
                        <span className={styles.optName}>{opt.display_name}</span>
                        <span className={styles.optMeta}>
                          <span className={styles.roleTag}>{opt.role}</span>
                          {opt.mobile && <span>{opt.mobile}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button type="button" className={styles.skipBtn} onClick={() => setEntitySkipped(true)}>
                Skip
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ════ Bill Allocation — Open Bills ═══════════════════════════════ */}
      {showBillStep && (
        <div ref={step2BillRef} className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepLabel}>
              {voucherType.nature === 'receipt' ? 'Open Sales Invoices' : 'Open Bills'}
              <span className={styles.optionalTag}>
                {voucherType.nature === 'receipt' ? ' · allocate this receipt' : ' · allocate this payment'}
              </span>
            </span>
          </div>
          <div className={styles.body}>
            {billStepDone ? (
              <div className={styles.selectedChip}>
                <span>
                  {billAllocs.length} bill{billAllocs.length > 1 ? 's' : ''} selected
                  {' — '}{formatIndianCurrency(billAllocs.reduce((s, r) => s + r.amount_allocated, 0))}
                </span>
                <button
                  type="button"
                  onClick={() => { setBillStepDone(false); setBillStepSkipped(false); setDirectPaymentType(null); setNewInvoiceMode(false) }}
                  aria-label="Edit allocation"
                >
                  <X size={13} />
                </button>
              </div>
            ) : newInvoiceMode ? (
              // New invoice mode chip
              <div className={styles.selectedChip}>
                <span>
                  {voucherType.nature === 'receipt'
                    ? '📄 New sales invoice — creating sale + receipt together'
                    : '📄 New purchase invoice — creating purchase + payment together'}
                  {entityLedgerName && (
                    <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginLeft: '0.375rem' }}>
                      via {entityLedgerName}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => { setNewInvoiceMode(false); setBillStepSkipped(false); setEntityLedgerId(null); setEntityLedgerName('') }}
                  aria-label="Cancel new invoice"
                >
                  <X size={13} />
                </button>
              </div>
            ) : billStepSkipped && directPaymentType !== null ? (
              // Explicit direct-payment choice made
              <div className={styles.skippedChip}>
                <span>
                  {directPaymentType === 'expense'
                    ? (voucherType.nature === 'receipt' ? 'Direct income — no invoice' : 'Direct expense — no invoice')
                    : (voucherType.nature === 'receipt' ? 'Advance received — to settle later' : 'Advance payment — to settle later')
                  }
                </span>
                <button
                  type="button"
                  onClick={() => { setBillStepSkipped(false); setBillStepDone(false); setDirectPaymentType(null); setNewInvoiceMode(false) }}
                  aria-label="Change"
                >
                  <X size={13} />
                </button>
              </div>
            ) : billStepSkipped || (openBillsLoaded && openBills.length === 0) ? (
              // Intent card — shown when no open bills exist, or user dismissed BillAllocPanel
              <div className={styles.intentCard}>
                <p className={styles.intentCardTitle}>
                  {openBills.length === 0
                    ? (voucherType.nature === 'receipt'
                        ? 'No open invoices found. What kind of receipt is this?'
                        : 'No open bills found. What kind of payment is this?')
                    : (voucherType.nature === 'receipt'
                        ? 'None of those match. What kind of receipt is this?'
                        : 'None of those match. What kind of payment is this?')
                  }
                </p>
                <div className={styles.intentChoices}>
                  {pairedVoucherType && (
                    <button
                      type="button"
                      className={styles.intentBtn}
                      onClick={handleNewInvoiceIntent}
                    >
                      <span className={styles.intentBtnLabel}>
                        {voucherType.nature === 'receipt' ? '📄 New sales invoice' : '📄 New purchase invoice'}
                      </span>
                      <span className={styles.intentBtnSub}>
                        {voucherType.nature === 'receipt'
                          ? 'Create sale + receipt atomically'
                          : 'Create purchase + payment atomically'}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.intentBtn}
                    onClick={() => { setBillStepSkipped(true); setDirectPaymentType('expense') }}
                  >
                    <span className={styles.intentBtnLabel}>
                      {voucherType.nature === 'receipt' ? '💰 Direct income' : '📋 Direct expense'}
                    </span>
                    <span className={styles.intentBtnSub}>
                      {voucherType.nature === 'receipt'
                        ? 'Rent, misc income — hits P&L'
                        : 'Salary, wages, rent — hits P&L'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.intentBtn}
                    onClick={() => { setBillStepSkipped(true); setDirectPaymentType('advance') }}
                  >
                    <span className={styles.intentBtnLabel}>
                      {voucherType.nature === 'receipt' ? '⏳ Advance received' : '⏳ Advance payment'}
                    </span>
                    <span className={styles.intentBtnSub}>
                      {voucherType.nature === 'receipt'
                        ? 'From customer — sits on Balance Sheet'
                        : 'Travel, deposit — sits on Balance Sheet'}
                    </span>
                  </button>
                </div>
                {billStepSkipped && openBills.length > 0 && (
                  <button
                    type="button"
                    className={styles.intentBackBtn}
                    onClick={() => { setBillStepSkipped(false); setBillStepDone(false) }}
                  >
                    ← Back to open bills
                  </button>
                )}
              </div>
            ) : (
              <BillAllocPanel
                bills={openBills}
                loading={openBillsLoading || !openBillsLoaded}
                onConfirm={(rows, total) => {
                  setBillAllocs(rows)
                  setBillStepDone(true)
                  setTotalAmount(total.toFixed(2))
                  setStep2Committed(false)
                  if (lines.length === 1) {
                    setLines(prev => prev.map((l, i) =>
                      i === 0 ? { ...l, amount: total.toFixed(2) } : l))
                  }
                }}
                onSkip={() => { setBillAllocs([]); setBillStepSkipped(true); setDirectPaymentType(null) }}
              />
            )}
          </div>
        </div>
      )}

      {/* ════ Step 2 — How much ═══════════════════════════════════════════ */}
      {show2 && (
        <div className={styles.step}>
          <StepHead num={2} done={step2Done} label="How much?" />
          <div className={styles.body}>
            <div className={styles.amountRow}>
              <span className={styles.rupeeSign}>₹</span>
              <input
                className={styles.amountInput}
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={totalAmount}
                onChange={e => handleTotalChange(e.target.value)}
                onBlur={commitStep2}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Tab') commitStep2() }}
                autoFocus
              />
            </div>
            {step2Done && (
              <div className={styles.amountFormatted}>{formatIndianCurrency(totalNum)}</div>
            )}
          </div>
        </div>
      )}

      {/* ════ Step 3 — What for ═══════════════════════════════════════════ */}
      {show3 && (
        <div ref={step3Ref} className={styles.step}>
          <StepHead num={3} done={step3Done} label={
            voucherType.nature === 'receipt' ? 'What income is this for?' : 'What is this for?'
          } />
          <div className={styles.body}>
            <div className={styles.expenseLines}>
              {lines.map(line => (
                <ExpenseLineRow
                  key={line.key}
                  line={line}
                  companyId={companyId}
                  autoFocus={!line.ledger_id}
                  showAmount={lines.length > 1}
                  onChange={(f, v) => updateLine(line.key, f, v)}
                  onRemove={() => removeLine(line.key)}
                  canRemove={lines.length > 1}
                />
              ))}
            </div>

            <button type="button" className={styles.addLineBtn} onClick={addLine}>
              <Plus size={14} /> Add expense item
            </button>

            {balanceHint && (
              <div className={styles.balanceWarn}>{balanceHint}</div>
            )}

            {step3Done && (
              <div className={styles.balanceOk}>
                <Check size={13} /> Total matches — {formatIndianCurrency(totalNum)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ════ Step 4 — Account (receiving for receipt / paying for payment) ════ */}
      {show4 && (
        <div ref={step4Ref} className={styles.step}>
          <StepHead num={4} done={step4Done} label={isReceiptMode ? 'Which account is the money coming into?' : 'Paying from which account?'} />
          <div className={styles.body}>
            {accountsLoading ? (
              <Loader2 size={18} className={styles.spin} />
            ) : paymentAccounts.length === 0 ? (
              <div className={styles.emptyNote}>
                No payment accounts found — add a Cash or Bank ledger in Ledgers first.
              </div>
            ) : (
              <select
                className={styles.input}
                value={selectedAccountId}
                onChange={e => setSelectedAccountId(e.target.value)}
              >
                <option value="">— Select account —</option>
                {paymentAccounts.map(acc => (
                  <option key={acc.id} value={acc.id}>
                    {acc.type === 'bank'
                      ? `${acc.name}${acc.account_number ? ` (•• ${acc.account_number.slice(-4)})` : ''}`
                      : acc.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      )}

      {/* ════ Step 5 — How paying (bank only) ════════════════════════════ */}
      {show5 && (
        <div ref={step5Ref} className={styles.step}>
          <StepHead num={5} done={step5Done} label="How are you paying?" />
          <div className={styles.body}>
            <div className={styles.modeGrid}>
              {['UPI', 'NEFT', 'RTGS', 'IMPS', 'Cheque'].map(m => (
                <button
                  key={m}
                  type="button"
                  className={`${styles.modeBtn} ${paymentMode === m ? styles.modeBtnActive : ''}`}
                  onClick={() => { setPaymentMode(m); setUtrNumber(''); setChequeNumber(''); setChequeDate('') }}
                >
                  {m}
                </button>
              ))}
            </div>

            {paymentMode && UTR_MODES.has(paymentMode) && (
              <input
                className={styles.input}
                placeholder="UTR / transaction reference number"
                value={utrNumber}
                onChange={e => setUtrNumber(e.target.value)}
                autoFocus
              />
            )}

            {paymentMode === 'Cheque' && (
              <div className={styles.row2}>
                <input
                  className={styles.input}
                  placeholder="Cheque number"
                  value={chequeNumber}
                  onChange={e => setChequeNumber(e.target.value)}
                  autoFocus
                />
                <input
                  type="date"
                  className={styles.input}
                  value={chequeDate}
                  onChange={e => setChequeDate(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ════ Step 6 — Reference / note ══════════════════════════════════ */}
      {show6 && (
        <div ref={step6Ref} className={styles.step}>
          <StepHead num={6} done optional label="Any reference or note?" />
          <div className={styles.body}>
            <input
              className={styles.input}
              placeholder="Invoice no., PO no., cheque no.…"
              value={refNumber}
              onChange={e => setRefNumber(e.target.value)}
            />
            <textarea
              className={styles.textarea}
              rows={2}
              placeholder="Being payment towards…"
              value={narration}
              onChange={e => setNarration(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* ════ Step 7 — Attachments ═══════════════════════════════════════ */}
      {show7 && (
        <div className={styles.step}>
          <StepHead num={7} done={stagedFiles.length > 0} optional label="Are there invoices or bills to attach to this voucher?" />
          <div className={styles.body}>
            <div className={styles.attachPrompt}>
              Are there Invoices/Bills you want to Attach to this Voucher?
            </div>
            {/* Upload zone */}
            <div
              className={styles.uploadZone}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add(styles.uploadZoneDrag) }}
              onDragLeave={e => e.currentTarget.classList.remove(styles.uploadZoneDrag)}
              onDrop={e => {
                e.preventDefault()
                e.currentTarget.classList.remove(styles.uploadZoneDrag)
                const dropped = Array.from(e.dataTransfer.files)
                setStagedFiles(prev => {
                  const existing = new Set(prev.map(f => f.name + f.size))
                  return [...prev, ...dropped.filter(f => !existing.has(f.name + f.size))]
                })
              }}
            >
              <Paperclip size={18} className={styles.uploadIcon} />
              <span className={styles.uploadText}>
                Tap to add photos or PDFs
              </span>
              <span className={styles.uploadSub}>Invoice, receipt, bank screenshot · max 10 MB each</span>
            </div>

            {/* QR relay button — for desktop users who want to use phone camera */}
            <div className={styles.relayRow}>
              <span className={styles.relayOr}>or</span>
              <QRRelayModal
                companyId={companyId}
                onFileReceived={file => {
                  setStagedFiles(prev => {
                    const existing = new Set(prev.map(f => f.name + f.size))
                    return existing.has(file.name + file.size) ? prev : [...prev, file]
                  })
                }}
              />
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

            <div className={styles.attachHelper}>
              Bills, invoices, or supporting PDFs/photos can be attached now or after the voucher is completed.
            </div>

            {/* Staged file list */}
            {stagedFiles.length > 0 && (
              <div className={styles.stagedList}>
                {stagedFiles.map((file, idx) => (
                  <div key={idx} className={styles.stagedItem}>
                    <span className={styles.stagedIcon}>
                      {isImage(file.type) ? <ImageIcon size={14} /> : <FileText size={14} />}
                    </span>
                    <span className={styles.stagedName}>{file.name}</span>
                    <span className={styles.stagedSize}>{formatFileSize(file.size)}</span>
                    <button
                      type="button"
                      className={styles.stagedRemove}
                      onClick={e => { e.stopPropagation(); removeStagedFile(idx) }}
                      aria-label="Remove"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ════ Advanced entries viewer ═════════════════════════════════════ */}
      {step3Done && step4Done && (
        <div className={styles.advancedSection}>
          <button
            type="button"
            className={styles.advancedToggle}
            onClick={() => setShowAdvanced(v => !v)}
          >
            {showAdvanced ? <EyeOff size={13} /> : <Eye size={13} />}
            {showAdvanced ? 'Hide accounting entries' : 'View accounting entries'}
          </button>

          {showAdvanced && (
            <div className={styles.advancedTable}>
              <div className={`${styles.advRow} ${styles.advHeader}`}>
                <span>Ledger</span>
                <span>Dr / Cr</span>
                <span>Amount</span>
              </div>
              {advEntries.map((e, i) => (
                <div key={i} className={styles.advRow}>
                  <span>{ledgerLabel.get(e.ledger_id) || '—'}</span>
                  <span className={e.entry_type === 'Dr' ? styles.drTag : styles.crTag}>{e.entry_type}</span>
                  <span>{formatIndianCurrency(e.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ════ Step 8 — Review & Confirm ══════════════════════════════════ */}
      {canSubmit && (
        <div ref={step8Ref} className={styles.step}>
          <StepHead num={8} done={false} label="Review & Confirm" />
          <div className={styles.body}>
            {!showPreview ? (
              <button
                type="button"
                className={styles.reviewTriggerBtn}
                onClick={() => setShowPreview(true)}
              >
                <Eye size={15} /> Review before submitting
              </button>
            ) : (
              <div className={styles.reviewCard}>
                <div className={styles.reviewRow}>
                  <span className={styles.reviewLabel}>Paying to</span>
                  <span className={styles.reviewValue}>{entityLabel || 'Not specified'}</span>
                </div>
                <div className={styles.reviewRow}>
                  <span className={styles.reviewLabel}>Amount</span>
                  <span className={`${styles.reviewValue} ${styles.reviewAmount}`}>{formatIndianCurrency(totalNum)}</span>
                </div>
                <div className={styles.reviewRow}>
                  <span className={styles.reviewLabel}>For</span>
                  <div className={styles.reviewList}>
                    {lines.map(l => (
                      <div key={l.key}>{l.ledger_name} — {formatIndianCurrency(parseFloat(l.amount))}</div>
                    ))}
                  </div>
                </div>
                <div className={styles.reviewRow}>
                  <span className={styles.reviewLabel}>From</span>
                  <span className={styles.reviewValue}>{selectedAccount?.name}{selectedAccount ? ` (${selectedAccount.type === 'bank' ? 'Bank' : 'Cash'})` : ''}</span>
                </div>
                {paymentMode && paymentMode !== 'cash' && (
                  <div className={styles.reviewRow}>
                    <span className={styles.reviewLabel}>Mode</span>
                    <span className={styles.reviewValue}>{paymentMode}</span>
                  </div>
                )}
                {refNumber && (
                  <div className={styles.reviewRow}>
                    <span className={styles.reviewLabel}>Reference</span>
                    <span className={styles.reviewValue}>{refNumber}</span>
                  </div>
                )}
                {narration && (
                  <div className={styles.reviewRow}>
                    <span className={styles.reviewLabel}>Narration</span>
                    <span className={styles.reviewValue}>{narration}</span>
                  </div>
                )}
                <div className={styles.reviewRow}>
                  <span className={styles.reviewLabel}>Attachments</span>
                  <span className={styles.reviewValue}>
                    {stagedFiles.length === 0 ? 'None' : `${stagedFiles.length} file${stagedFiles.length > 1 ? 's' : ''}`}
                  </span>
                </div>
                <div className={styles.reviewActions}>
                  <button type="button" className={styles.reviewEditBtn} onClick={() => setShowPreview(false)}>
                    ← Edit
                  </button>
                  <button
                    type="button"
                    className={styles.reviewConfirmBtn}
                    onClick={handleSubmit}
                    disabled={saving}
                  >
                    {saving ? <Loader2 size={14} className={styles.spin} /> : <Check size={14} />}
                    {saving ? 'Submitting…' : 'Confirm & Submit'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  )
}

// ── StepHead sub-component ────────────────────────────────────────────────────

function StepHead({
  num, done, label, optional = false,
}: { num: number; done: boolean; label: string; optional?: boolean }) {
  return (
    <div className={styles.stepHead}>
      <span className={`${styles.stepNum} ${done ? styles.numDone : optional ? styles.numOptional : styles.numActive}`}>
        {done ? <Check size={11} /> : num}
      </span>
      <span className={styles.stepLabel}>
        {label}
        {optional && <span className={styles.optionalTag}> (optional)</span>}
      </span>
    </div>
  )
}

// ── ExpenseLineRow sub-component ──────────────────────────────────────────────

interface ExpenseLineRowProps {
  line:       ExpenseLine
  companyId:  string
  autoFocus:  boolean
  showAmount: boolean
  onChange:   (field: keyof Omit<ExpenseLine, 'key'>, val: string) => void
  onRemove:   () => void
  canRemove:  boolean
}

function ExpenseLineRow({ line, companyId, autoFocus, showAmount, onChange, onRemove, canRemove }: ExpenseLineRowProps) {
  const [query,       setQuery]       = useState('')
  const [options,     setOptions]     = useState<{ id: string; name: string }[]>([])
  const [loading,     setLoading]     = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSearch = (val: string) => {
    setQuery(val)
    setHighlighted(-1)
    if (!val.trim()) { setOptions([]); return }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setLoading(true)
      const res = await searchLedgers(companyId, val)
      setOptions(res.map(r => ({ id: r.id, name: r.name })))
      setLoading(false)
    }, 250)
  }

  const select = (opt: { id: string; name: string }) => {
    onChange('ledger_id',   opt.id)
    onChange('ledger_name', opt.name)
    setQuery('')
    setOptions([])
    setHighlighted(-1)
  }

  // All items: real ledger options + optional create entry
  const showCreate = query.trim().length > 0
  const allOptions = options

  return (
    <div className={styles.expenseLine}>

      {/* Ledger search */}
      <div className={styles.lineTypeahead}>
        {line.ledger_id ? (
          <div className={styles.lineChip}>
            <span>{line.ledger_name}</span>
            <button type="button" onClick={() => { onChange('ledger_id', ''); onChange('ledger_name', '') }}>
              <X size={11} />
            </button>
          </div>
        ) : (
          <div className={styles.lineTypeaheadInner}>
            <input
              className={styles.lineInput}
              value={query}
              onChange={e => handleSearch(e.target.value)}
              placeholder="Ledger / expense type…"
              autoFocus={autoFocus}
              onKeyDown={e => {
                const totalItems = allOptions.length + (showCreate ? 1 : 0)
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setHighlighted(h => Math.min(h + 1, totalItems - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setHighlighted(h => Math.max(h - 1, 0))
                } else if (e.key === 'Escape') {
                  setOptions([]); setHighlighted(-1)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  const isCreateHighlighted = highlighted === allOptions.length && showCreate
                  if (highlighted >= 0 && highlighted < allOptions.length) {
                    select(allOptions[highlighted])
                  } else if (isCreateHighlighted || (highlighted < 0 && allOptions.length === 0 && query.trim())) {
                    // Create ledger — navigate to /ledgers with the name pre-filled via state
                    toast.info(`Create "${query.trim()}" in Ledgers, then return here`, { duration: 5000 })
                  } else if (allOptions.length > 0) {
                    select(allOptions[0])
                  }
                }
              }}
            />
            {loading && <Loader2 size={12} className={styles.spin} />}
            {(allOptions.length > 0 || showCreate) && (
              <ul className={styles.dropdown}>
                {allOptions.map((opt, idx) => (
                  <li
                    key={opt.id}
                    className={idx === highlighted ? styles.dropdownHighlighted : undefined}
                    onMouseDown={() => select(opt)}
                    onMouseEnter={() => setHighlighted(idx)}
                  >
                    {opt.name}
                  </li>
                ))}
                {showCreate && allOptions.length === 0 && (
                  <li
                    className={highlighted === allOptions.length ? styles.dropdownHighlighted : styles.dropdownCreate}
                    onMouseDown={() => toast.info(`Create "${query.trim()}" in Ledgers, then return here`, { duration: 5000 })}
                    onMouseEnter={() => setHighlighted(allOptions.length)}
                  >
                    + Create ledger &ldquo;{query.trim()}&rdquo;
                  </li>
                )}
                {allOptions.length === 0 && !showCreate && (
                  <li className={styles.dropdownEmpty}>No matching ledger found</li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Amount — only shown when multiple lines; single-line amount is the total */}
      {showAmount && (
      <div className={styles.lineAmountWrap}>
        <span className={styles.lineRupee}>₹</span>
        <input
          className={styles.lineAmountInput}
          type="number"
          step="0.01"
          min="0"
          placeholder="0.00"
          value={line.amount}
          onChange={e => onChange('amount', e.target.value)}
        />
      </div>
      )}

      {/* Remove */}
      {canRemove && (
        <button type="button" className={styles.removeLine} onClick={onRemove} aria-label="Remove">
          <Trash2 size={13} />
        </button>
      )}
    </div>
  )
}
