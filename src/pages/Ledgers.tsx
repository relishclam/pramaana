import { useState, useEffect, useMemo, useRef } from 'react'
import {
  Lock, AlertTriangle, Plus, Pencil, ChevronDown,
  ChevronRight, Search, X, Check, Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import styles from './Ledgers.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

type Nature = 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE'

interface LedgerGroup {
  id: string
  company_id: string | null
  code: string
  name: string
  parent_id: string | null
  nature: Nature
  is_system: boolean
  sort_order: number
  is_active: boolean
}

interface Ledger {
  id: string
  company_id: string
  group_id: string
  code: string | null
  name: string
  entity_id: string | null
  opening_balance: number
  opening_dr_cr: 'Dr' | 'Cr'
  tally_ledger_name: string | null
  gstin: string | null
  is_bank_account: boolean
  bank_name: string | null
  account_number: string | null
  ifsc: string | null
  is_tax_ledger: boolean
  tax_type: string | null
  tax_rate: number | null
  is_active: boolean
  group: { id: string; name: string; nature: string } | null
}

interface EntityOption {
  entity_role_id: string
  entity_id: string
  display_name: string
  role: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const NATURE_COLOURS: Record<Nature, string> = {
  ASSET:     'var(--teal)',
  LIABILITY: 'var(--gold)',
  INCOME:    'var(--success)',
  EXPENSE:   'var(--error)',
}

function canWrite(
  isSuper: boolean,
  role: string | null,
): boolean {
  return isSuper || role === 'admin'
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Ledgers() {
  const [tab, setTab] = useState<'groups' | 'ledgers'>('groups')

  return (
    <div className={styles.page}>
      <div className={styles.tabBar}>
        <button
          className={`${styles.tab} ${tab === 'groups' ? styles.tabActive : ''}`}
          onClick={() => setTab('groups')}
        >
          Ledger Groups
        </button>
        <button
          className={`${styles.tab} ${tab === 'ledgers' ? styles.tabActive : ''}`}
          onClick={() => setTab('ledgers')}
        >
          Ledgers
        </button>
      </div>

      <div className={styles.content}>
        {tab === 'groups'  && <LedgerGroupsTab />}
        {tab === 'ledgers' && <LedgersTab />}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB 1 — LEDGER GROUPS
// ══════════════════════════════════════════════════════════════════════════════

function LedgerGroupsTab() {
  const { user } = useAuth()
  const activeCompanyId = user?.activeCompany?.id ?? null
  const writable = canWrite(
    user?.profile.is_super_admin ?? false,
    user?.activeRole ?? null,
  )

  const [groups,  setGroups]  = useState<LedgerGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editTarget, setEditTarget] = useState<LedgerGroup | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // ── Fetch all groups (system + company) ─────────────────────────────────────
  const fetchGroups = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .schema('pramaana')
      .from('ledger_groups')
      .select('*')
      .order('sort_order')

    if (error) {
      toast.error('Failed to load ledger groups: ' + error.message)
    } else {
      setGroups((data ?? []) as LedgerGroup[])
      // Auto-expand top-level on first load
      setExpanded(prev => {
        if (prev.size > 0) return prev
        const roots = (data ?? []).filter((g: LedgerGroup) => !g.parent_id)
        return new Set(roots.map((g: LedgerGroup) => g.id))
      })
    }
    setLoading(false)
  }

  useEffect(() => { fetchGroups() }, [activeCompanyId])

  // ── Tree: index children by parent_id ───────────────────────────────────────
  const childrenOf = useMemo(() => {
    const map = new Map<string | null, LedgerGroup[]>()
    for (const g of groups) {
      const key = g.parent_id ?? null
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(g)
    }
    return map
  }, [groups])

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const openCreate = () => { setEditTarget(null); setShowForm(true) }
  const openEdit   = (g: LedgerGroup) => { setEditTarget(g); setShowForm(true) }

  // ── Recursive tree node ──────────────────────────────────────────────────────
  const renderTree = (parentId: string | null, depth: number) => {
    const children = childrenOf.get(parentId) ?? []
    return children.map(group => {
      const hasChildren = (childrenOf.get(group.id) ?? []).length > 0
      const isOpen = expanded.has(group.id)
      const isCompanyGroup = !!group.company_id

      return (
        <div key={group.id}>
          <div
            className={`${styles.groupRow} ${group.is_system ? styles.groupRowSystem : styles.groupRowCompany}`}
            style={{ paddingLeft: `${1 + depth * 1.25}rem` }}
          >
            {/* Expand toggle */}
            <button
              className={styles.expandBtn}
              onClick={() => hasChildren && toggleExpand(group.id)}
              aria-label={isOpen ? 'Collapse' : 'Expand'}
              style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
            >
              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>

            {/* Name + nature badge */}
            <span className={styles.groupName}>{group.name}</span>
            <span
              className={styles.natureBadge}
              style={{ color: NATURE_COLOURS[group.nature] }}
            >
              {group.nature}
            </span>

            {/* Lock or edit */}
            {group.is_system ? (
              <span className={styles.lockIcon} title="System group — read only">
                <Lock size={13} />
              </span>
            ) : (
              writable && isCompanyGroup && (
                <button
                  className={styles.rowActionBtn}
                  onClick={() => openEdit(group)}
                  title="Edit group"
                >
                  <Pencil size={13} />
                </button>
              )
            )}
          </div>

          {/* Children */}
          {isOpen && renderTree(group.id, depth + 1)}
        </div>
      )
    })
  }

  return (
    <div>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <span className={styles.toolbarTitle}>Chart of Accounts Hierarchy</span>
        {writable && (
          <button className={styles.btnPrimary} onClick={openCreate}>
            <Plus size={15} /> New Group
          </button>
        )}
      </div>

      {/* Tree */}
      {loading ? (
        <div className={styles.loading}><Loader2 size={20} className={styles.spin} /></div>
      ) : (
        <div className={styles.tree}>
          {renderTree(null, 0)}
        </div>
      )}

      {/* Slide-over form */}
      {showForm && (
        <GroupForm
          groups={groups}
          editTarget={editTarget}
          activeCompanyId={activeCompanyId}
          onClose={() => setShowForm(false)}
          onSaved={fetchGroups}
        />
      )}
    </div>
  )
}

// ── Group Create / Edit Form ───────────────────────────────────────────────────

interface GroupFormProps {
  groups: LedgerGroup[]
  editTarget: LedgerGroup | null
  activeCompanyId: string | null
  onClose: () => void
  onSaved: () => void
}

function GroupForm({ groups, editTarget, activeCompanyId, onClose, onSaved }: GroupFormProps) {
  const [name,     setName]     = useState(editTarget?.name ?? '')
  const [parentId, setParentId] = useState(editTarget?.parent_id ?? '')
  const [nature,   setNature]   = useState<Nature>(editTarget?.nature ?? 'ASSET')
  const [saving,   setSaving]   = useState(false)

  // Auto-fill nature from parent when parent changes
  const handleParentChange = (pid: string) => {
    setParentId(pid)
    if (pid) {
      const parent = groups.find(g => g.id === pid)
      if (parent) setNature(parent.nature)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { toast.error('Name is required'); return }
    if (!activeCompanyId) { toast.error('No active company'); return }

    setSaving(true)

    const payload = {
      company_id: activeCompanyId,
      name:       name.trim(),
      parent_id:  parentId || null,
      nature,
      // code: derive from name — uppercase + underscores
      code: name.trim().toUpperCase().replace(/\s+/g, '_').slice(0, 30),
    }

    const { error } = editTarget
      ? await supabase.schema('pramaana').from('ledger_groups').update(payload).eq('id', editTarget.id)
      : await supabase.schema('pramaana').from('ledger_groups').insert(payload)

    if (error) {
      toast.error(error.message)
    } else {
      toast.success(editTarget ? 'Group updated' : 'Group created')
      onSaved()
      onClose()
    }
    setSaving(false)
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.drawer}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>
            {editTarget ? 'Edit Ledger Group' : 'New Ledger Group'}
          </h2>
          <button className={styles.drawerClose} onClick={onClose}><X size={18} /></button>
        </div>

        <form className={styles.drawerForm} onSubmit={handleSubmit}>
          {/* Name */}
          <div className={styles.field}>
            <label className={styles.label}>Group Name <span className={styles.req}>*</span></label>
            <input
              className={styles.input}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Trade Receivables"
              autoFocus
            />
          </div>

          {/* Parent */}
          <div className={styles.field}>
            <label className={styles.label}>Parent Group</label>
            <select
              className={styles.select}
              value={parentId}
              onChange={e => handleParentChange(e.target.value)}
            >
              <option value="">(Top level)</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>

          {/* Nature */}
          <div className={styles.field}>
            <label className={styles.label}>Nature <span className={styles.req}>*</span></label>
            <div className={styles.segmented}>
              {(['ASSET','LIABILITY','INCOME','EXPENSE'] as Nature[]).map(n => (
                <button
                  key={n}
                  type="button"
                  className={`${styles.seg} ${nature === n ? styles.segActive : ''}`}
                  onClick={() => setNature(n)}
                  style={nature === n ? { borderColor: NATURE_COLOURS[n], color: NATURE_COLOURS[n] } : {}}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.drawerActions}>
            <button type="button" className={styles.btnSecondary} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={styles.btnPrimary} disabled={saving}>
              {saving ? <Loader2 size={15} className={styles.spin} /> : <Check size={15} />}
              {editTarget ? 'Save Changes' : 'Create Group'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB 2 — LEDGERS
// ══════════════════════════════════════════════════════════════════════════════

function LedgersTab() {
  const { user } = useAuth()
  const activeCompanyId = user?.activeCompany?.id ?? null
  const writable = canWrite(
    user?.profile.is_super_admin ?? false,
    user?.activeRole ?? null,
  )

  const [ledgers,    setLedgers]    = useState<Ledger[]>([])
  const [groups,     setGroups]     = useState<LedgerGroup[]>([])
  const [loading,    setLoading]    = useState(true)
  const [search,     setSearch]     = useState('')
  const [showForm,   setShowForm]   = useState(false)
  const [editTarget, setEditTarget] = useState<Ledger | null>(null)

  const fetchData = async () => {
    if (!activeCompanyId) return
    setLoading(true)

    const [ledgerRes, groupRes] = await Promise.all([
      supabase
        .schema('pramaana')
        .from('ledgers')
        .select('*, group:ledger_groups(id, name, nature)')
        .eq('company_id', activeCompanyId)
        .order('name'),
      supabase
        .schema('pramaana')
        .from('ledger_groups')
        .select('*')
        .order('sort_order'),
    ])

    if (ledgerRes.error) toast.error('Failed to load ledgers: ' + ledgerRes.error.message)
    if (groupRes.error)  toast.error('Failed to load groups: '  + groupRes.error.message)

    setLedgers((ledgerRes.data ?? []) as Ledger[])
    setGroups((groupRes.data  ?? []) as LedgerGroup[])
    setLoading(false)
  }

  useEffect(() => { fetchData() }, [activeCompanyId])

  const filtered = useMemo(() => {
    if (!search.trim()) return ledgers
    const q = search.toLowerCase()
    return ledgers.filter(l =>
      l.name.toLowerCase().includes(q) ||
      l.group?.name.toLowerCase().includes(q) ||
      (l.tally_ledger_name ?? '').toLowerCase().includes(q),
    )
  }, [ledgers, search])

  const openCreate = () => { setEditTarget(null); setShowForm(true) }
  const openEdit   = (l: Ledger) => { setEditTarget(l); setShowForm(true) }

  return (
    <div>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <Search size={15} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            placeholder="Search ledgers…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className={styles.searchClear} onClick={() => setSearch('')}>
              <X size={13} />
            </button>
          )}
        </div>
        {writable && (
          <button className={styles.btnPrimary} onClick={openCreate}>
            <Plus size={15} /> New Ledger
          </button>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className={styles.loading}><Loader2 size={20} className={styles.spin} /></div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyState}>
          {ledgers.length === 0
            ? 'No ledgers yet. Create your first ledger to get started.'
            : 'No ledgers match your search.'}
        </div>
      ) : (
        <div className={styles.ledgerTable}>
          <div className={styles.ledgerHeader}>
            <span>Name</span>
            <span>Group</span>
            <span>Nature</span>
            <span>Tally Name</span>
            <span style={{ textAlign: 'right' }}>Opening Bal.</span>
            {writable && <span />}
          </div>
          {filtered.map(ledger => {
            const tallyMissing = !ledger.tally_ledger_name?.trim()
            const nature = (ledger.group?.nature ?? '') as Nature
            return (
              <div key={ledger.id} className={`${styles.ledgerRow} ${!ledger.is_active ? styles.ledgerInactive : ''}`}>
                <span className={styles.ledgerName}>
                  {tallyMissing && (
                    <span title="Tally ledger name missing — will break Tally export">
                      <AlertTriangle size={13} className={styles.tallyWarn} />
                    </span>
                  )}
                  {ledger.name}
                </span>
                <span className={styles.ledgerGroup}>{ledger.group?.name ?? '—'}</span>
                <span
                  className={styles.natureBadge}
                  style={{ color: nature ? NATURE_COLOURS[nature] : undefined }}
                >
                  {nature || '—'}
                </span>
                <span className={`${styles.tallyName} ${tallyMissing ? styles.tallyNameMissing : ''}`}>
                  {ledger.tally_ledger_name || <em>not set</em>}
                </span>
                <span className={styles.openingBal}>
                  {ledger.opening_balance !== 0 && (
                    <>
                      ₹{Math.abs(ledger.opening_balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      {' '}
                      <span className={styles.drCr}>{ledger.opening_dr_cr}</span>
                    </>
                  )}
                </span>
                {writable && (
                  <button className={styles.rowActionBtn} onClick={() => openEdit(ledger)}>
                    <Pencil size={13} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Slide-over form */}
      {showForm && (
        <LedgerForm
          groups={groups}
          editTarget={editTarget}
          activeCompanyId={activeCompanyId}
          userId={user?.id ?? null}
          onClose={() => setShowForm(false)}
          onSaved={fetchData}
        />
      )}
    </div>
  )
}

// ── Ledger Create / Edit Form ─────────────────────────────────────────────────

interface LedgerFormProps {
  groups: LedgerGroup[]
  editTarget: Ledger | null
  activeCompanyId: string | null
  userId: string | null
  onClose: () => void
  onSaved: () => void
}

function LedgerForm({ groups, editTarget, activeCompanyId, userId, onClose, onSaved }: LedgerFormProps) {
  const [name,          setName]          = useState(editTarget?.name ?? '')
  const [groupId,       setGroupId]       = useState(editTarget?.group_id ?? '')
  const [tallyName,     setTallyName]     = useState(editTarget?.tally_ledger_name ?? '')
  const [openingBal,    setOpeningBal]    = useState(String(editTarget?.opening_balance ?? '0'))
  const [drCr,          setDrCr]          = useState<'Dr' | 'Cr'>(editTarget?.opening_dr_cr ?? 'Dr')
  const [gstin,         setGstin]         = useState(editTarget?.gstin ?? '')
  const [isActive,       setIsActive]       = useState(editTarget?.is_active ?? true)
  const [isBankAccount,  setIsBankAccount]  = useState(editTarget?.is_bank_account ?? false)
  const [bankName,       setBankName]       = useState(editTarget?.bank_name ?? '')
  const [accountNumber,  setAccountNumber]  = useState(editTarget?.account_number ?? '')
  const [ifsc,           setIfsc]           = useState(editTarget?.ifsc ?? '')
  const [isTaxLedger,    setIsTaxLedger]    = useState(editTarget?.is_tax_ledger ?? false)
  const [taxType,        setTaxType]        = useState(editTarget?.tax_type ?? '')
  const [taxRate,        setTaxRate]        = useState(String(editTarget?.tax_rate ?? ''))
  const [entitySearch,   setEntitySearch]   = useState('')
  const [entityOptions, setEntityOptions] = useState<EntityOption[]>([])
  const [entityId,      setEntityId]      = useState<string | null>(editTarget?.entity_id ?? null)
  const [entityLabel,   setEntityLabel]   = useState('')
  const [entityLoading, setEntityLoading] = useState(false)
  const [saving,        setSaving]        = useState(false)
  const entityTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Entity typeahead ────────────────────────────────────────────────────────
  const searchEntities = async (q: string) => {
    if (!q.trim() || !activeCompanyId) { setEntityOptions([]); return }
    setEntityLoading(true)
    const { data, error } = await supabase
      .schema('registry')
      .from('entity_roles')
      .select('id, entity_id, role, entity:entities(id, display_name)')
      .eq('company_id', activeCompanyId)
      .eq('is_active', true)
      .ilike('entity.display_name', `%${q}%`)
      .limit(10)

    if (!error && data) {
      // Supabase returns embedded relations as arrays, not objects
      type RawRow = { id: string; entity_id: string; role: string; entity: { id: string; display_name: string }[] }
      setEntityOptions(
        (data as RawRow[])
          .filter(r => r.entity?.length > 0)
          .map(r => ({
            entity_role_id: r.id,
            entity_id:      r.entity_id,
            display_name:   r.entity[0].display_name,
            role:           r.role,
          })),
      )
    }
    setEntityLoading(false)
  }

  const handleEntityInput = (val: string) => {
    setEntitySearch(val)
    if (entityTimer.current) clearTimeout(entityTimer.current)
    entityTimer.current = setTimeout(() => searchEntities(val), 300)
  }

  const selectEntity = (opt: EntityOption) => {
    setEntityId(opt.entity_id)
    setEntityLabel(`${opt.display_name} (${opt.role})`)
    setEntitySearch('')
    setEntityOptions([])
  }

  const clearEntity = () => {
    setEntityId(null)
    setEntityLabel('')
    setEntitySearch('')
    setEntityOptions([])
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim())    { toast.error('Name is required');          return }
    if (!groupId)        { toast.error('Ledger group is required');  return }
    if (!tallyName.trim()) { toast.error('Tally ledger name is required'); return }
    if (!activeCompanyId){ toast.error('No active company');         return }
    if (isBankAccount) {
      if (!bankName.trim())      { toast.error('Bank name is required');       return }
      if (!accountNumber.trim()) { toast.error('Account number is required');  return }
      if (ifsc.trim().length !== 11) { toast.error('IFSC must be 11 characters'); return }
    }

    setSaving(true)

    const payload = {
      company_id:         activeCompanyId,
      group_id:           groupId,
      name:               name.trim(),
      tally_ledger_name:  tallyName.trim(),
      opening_balance:    parseFloat(openingBal) || 0,
      opening_dr_cr:      drCr,
      gstin:              gstin.trim() || null,
      entity_id:          entityId || null,
      is_active:          isActive,
      is_bank_account:    isBankAccount,
      bank_name:          isBankAccount ? bankName.trim() : null,
      account_number:     isBankAccount ? accountNumber.trim() : null,
      ifsc:               isBankAccount ? ifsc.trim().toUpperCase() : null,
      is_tax_ledger:      isTaxLedger,
      tax_type:           isTaxLedger ? taxType || null : null,
      tax_rate:           isTaxLedger && taxRate ? parseFloat(taxRate) : null,
      ...(!editTarget ? { created_by: userId } : {}),
    }

    const { error } = editTarget
      ? await supabase.schema('pramaana').from('ledgers').update(payload).eq('id', editTarget.id)
      : await supabase.schema('pramaana').from('ledgers').insert(payload)

    if (error) {
      toast.error(error.message)
    } else {
      toast.success(editTarget ? 'Ledger updated' : 'Ledger created')
      onSaved()
      onClose()
    }
    setSaving(false)
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={styles.overlay}>
      <div className={styles.drawer}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>
            {editTarget ? 'Edit Ledger' : 'New Ledger'}
          </h2>
          <button className={styles.drawerClose} onClick={onClose}><X size={18} /></button>
        </div>

        <form className={styles.drawerForm} onSubmit={handleSubmit}>
          {/* Name */}
          <div className={styles.field}>
            <label className={styles.label}>Ledger Name <span className={styles.req}>*</span></label>
            <input
              className={styles.input}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. HDFC Current Account"
              autoFocus
            />
          </div>

          {/* Group */}
          <div className={styles.field}>
            <label className={styles.label}>Ledger Group <span className={styles.req}>*</span></label>
            <select
              className={styles.select}
              value={groupId}
              onChange={e => setGroupId(e.target.value)}
            >
              <option value="">— Select group —</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.nature})
                </option>
              ))}
            </select>
          </div>

          {/* Tally Name */}
          <div className={styles.field}>
            <label className={styles.label}>
              Tally Ledger Name <span className={styles.req}>*</span>
            </label>
            <input
              className={styles.input}
              value={tallyName}
              onChange={e => setTallyName(e.target.value)}
              placeholder="Exact name in Tally Prime"
            />
            <p className={styles.fieldHint}>
              ⚠ Must match Tally Prime ledger name exactly. Case-sensitive.
            </p>
          </div>

          {/* Opening Balance */}
          <div className={styles.field}>
            <label className={styles.label}>Opening Balance</label>
            <div className={styles.balanceRow}>
              <input
                className={`${styles.input} ${styles.inputFlex}`}
                type="number"
                step="0.01"
                min="0"
                value={openingBal}
                onChange={e => setOpeningBal(e.target.value)}
                placeholder="0.00"
              />
              <div className={styles.drCrToggle}>
                {(['Dr', 'Cr'] as const).map(t => (
                  <button
                    key={t}
                    type="button"
                    className={`${styles.drCrBtn} ${drCr === t ? styles.drCrBtnActive : ''}`}
                    onClick={() => setDrCr(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Entity Link */}
          <div className={styles.field}>
            <label className={styles.label}>Entity Link <span className={styles.labelOptional}>(optional)</span></label>
            {entityId ? (
              <div className={styles.entitySelected}>
                <span>{entityLabel || entityId}</span>
                <button type="button" className={styles.entityClear} onClick={clearEntity}>
                  <X size={13} />
                </button>
              </div>
            ) : (
              <div className={styles.typeaheadWrap}>
                <input
                  className={styles.input}
                  value={entitySearch}
                  onChange={e => handleEntityInput(e.target.value)}
                  placeholder="Search parties, vendors, customers…"
                />
                {entityLoading && <Loader2 size={13} className={`${styles.spin} ${styles.typeaheadSpinner}`} />}
                {entityOptions.length > 0 && (
                  <ul className={styles.typeaheadDropdown}>
                    {entityOptions.map(opt => (
                      <li
                        key={opt.entity_role_id}
                        className={styles.typeaheadOption}
                        onMouseDown={() => selectEntity(opt)}
                      >
                        <span>{opt.display_name}</span>
                        <span className={styles.entityRole}>{opt.role}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* GSTIN */}
          <div className={styles.field}>
            <label className={styles.label}>GSTIN <span className={styles.labelOptional}>(optional)</span></label>
            <input
              className={styles.input}
              value={gstin}
              onChange={e => setGstin(e.target.value.toUpperCase())}
              placeholder="e.g. 32AAUFR0742E1ZB"
              maxLength={15}
            />
          </div>

          {/* GST / Tax Ledger toggle */}
          <div className={styles.field}>
            <label className={styles.toggleRow}>
              <span className={styles.label} style={{ margin: 0 }}>GST / Tax Ledger</span>
              <button
                type="button"
                className={`${styles.toggle} ${isTaxLedger ? styles.toggleOn : ''}`}
                onClick={() => setIsTaxLedger(v => !v)}
                aria-pressed={isTaxLedger}
              />
            </label>
            <p className={styles.fieldHint}>
              Enable for Output CGST/SGST/IGST, Input CGST/SGST/IGST, TDS Payable, etc.
            </p>
          </div>

          {/* Tax type + rate — shown only when is_tax_ledger is true */}
          {isTaxLedger && (
            <>
              <div className={styles.field}>
                <label className={styles.label}>Tax Type <span className={styles.req}>*</span></label>
                <select
                  className={styles.select}
                  value={taxType}
                  onChange={e => setTaxType(e.target.value)}
                >
                  <option value="">— Select type —</option>
                  <option value="CGST">CGST — Central GST</option>
                  <option value="SGST">SGST — State GST</option>
                  <option value="IGST">IGST — Integrated GST</option>
                  <option value="CESS">CESS — GST Cess</option>
                  <option value="TDS">TDS — Tax Deducted at Source</option>
                  <option value="TCS">TCS — Tax Collected at Source</option>
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Default Rate (%) <span className={styles.labelOptional}>(optional)</span></label>
                <input
                  className={styles.input}
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={taxRate}
                  onChange={e => setTaxRate(e.target.value)}
                  placeholder="e.g. 9.00 for 9%"
                />
              </div>
            </>
          )}

          {/* Bank Account toggle */}
          <div className={styles.field}>
            <label className={styles.toggleRow}>
              <span className={styles.label} style={{ margin: 0 }}>Bank Account</span>
              <button
                type="button"
                className={`${styles.toggle} ${isBankAccount ? styles.toggleOn : ''}`}
                onClick={() => setIsBankAccount(v => !v)}
                aria-pressed={isBankAccount}
              />
            </label>
          </div>

          {/* Bank detail fields — shown only when is_bank_account is true */}
          {isBankAccount && (
            <>
              <div className={styles.field}>
                <label className={styles.label}>Bank Name <span className={styles.req}>*</span></label>
                <input
                  className={styles.input}
                  value={bankName}
                  onChange={e => setBankName(e.target.value)}
                  placeholder="e.g. HDFC Bank"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Account Number <span className={styles.req}>*</span></label>
                <input
                  className={styles.input}
                  value={accountNumber}
                  onChange={e => setAccountNumber(e.target.value)}
                  placeholder="e.g. 50100012345678"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>IFSC Code <span className={styles.req}>*</span></label>
                <input
                  className={styles.input}
                  value={ifsc}
                  onChange={e => setIfsc(e.target.value.toUpperCase())}
                  placeholder="e.g. HDFC0001234"
                  maxLength={11}
                />
              </div>
            </>
          )}

          {/* Active toggle */}
          {editTarget && (
            <div className={styles.field}>
              <label className={styles.toggleRow}>
                <span className={styles.label} style={{ margin: 0 }}>Active</span>
                <button
                  type="button"
                  className={`${styles.toggle} ${isActive ? styles.toggleOn : ''}`}
                  onClick={() => setIsActive(v => !v)}
                  aria-pressed={isActive}
                />
              </label>
            </div>
          )}

          <div className={styles.drawerActions}>
            <button type="button" className={styles.btnSecondary} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={styles.btnPrimary} disabled={saving}>
              {saving ? <Loader2 size={15} className={styles.spin} /> : <Check size={15} />}
              {editTarget ? 'Save Changes' : 'Create Ledger'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
