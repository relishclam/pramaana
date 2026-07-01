import { useState, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchResetPreview,
  resetCompanyData,
  parseLedgerGroupsCsv,
  importLedgerGroups,
  parseLedgersCsv,
  importLedgers,
  downloadCsvTemplate,
  LEDGER_GROUPS_TEMPLATE,
  LEDGERS_TEMPLATE,
  type ResetPreview,
  type LedgerGroupRow,
  type LedgerRow,
  type ImportResult,
} from '@/lib/admin'
import {
  fetchCompanyPaymentAccounts,
  deleteCompanyPaymentAccount,
  type CompanyPaymentAccount,
} from '@/lib/pay-now'
import css from './AdminPanel.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = e => resolve(e.target?.result as string ?? '')
    reader.onerror = () => reject(new Error('File read failed'))
    reader.readAsText(file, 'utf-8')
  })
}

// ── Reset tab ─────────────────────────────────────────────────────────────────

function DataReset({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [preview,   setPreview]   = useState<ResetPreview | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [confirm,   setConfirm]   = useState('')
  const [resetting, setResetting] = useState(false)
  const [done,      setDone]      = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const MAGIC = 'RESET ALL DATA'

  async function loadPreview() {
    setLoading(true)
    setError(null)
    try {
      setPreview(await fetchResetPreview(companyId))
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function handleReset() {
    if (confirm !== MAGIC) return
    setResetting(true)
    setError(null)
    try {
      const result = await resetCompanyData(companyId)
      setDone(true)
      setPreview(null)
      setConfirm('')
      toast.success(`Reset complete — ${result.vouchers_deleted} vouchers, ${result.ledgers_deleted} ledgers deleted`)
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className={css.dangerZone}>
      <p className={css.dangerTitle}>⚠ Data Reset — {companyName}</p>
      <p className={css.dangerDesc}>
        Permanently deletes all vouchers, ledgers, ledger groups, suspense sessions,
        inventory valuations, and sequence counters for this company.
        System groups, voucher types, users, and entities are <strong>preserved</strong>.
        Use this before importing fresh data from Tally.
      </p>

      {error && <div className={css.error}>{error}</div>}

      {done && (
        <div className={css.resetSuccess}>
          Reset complete. You can now import Tally data.
        </div>
      )}

      {!done && !preview && (
        <button className={css.templateBtn} onClick={loadPreview} disabled={loading}>
          {loading ? <><span className={css.spinner} /> Loading…</> : 'Show what will be deleted'}
        </button>
      )}

      {!done && preview && (
        <>
          <div className={css.previewGrid}>
            <div className={css.previewCard}>
              <div className={css.previewLabel}>Vouchers</div>
              <div className={preview.vouchers > 0 ? css.previewCountRed : css.previewCount}>{preview.vouchers}</div>
            </div>
            <div className={css.previewCard}>
              <div className={css.previewLabel}>Ledgers</div>
              <div className={preview.ledgers > 0 ? css.previewCountRed : css.previewCount}>{preview.ledgers}</div>
            </div>
            <div className={css.previewCard}>
              <div className={css.previewLabel}>Ledger Groups</div>
              <div className={preview.groups > 0 ? css.previewCountRed : css.previewCount}>{preview.groups}</div>
            </div>
            <div className={css.previewCard}>
              <div className={css.previewLabel}>Suspense Sessions</div>
              <div className={preview.sessions > 0 ? css.previewCountRed : css.previewCount}>{preview.sessions}</div>
            </div>
          </div>

          <label className={css.confirmLabel}>
            Type <strong>{MAGIC}</strong> to confirm:
          </label>
          <input
            className={css.confirmInput}
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            placeholder={MAGIC}
            autoComplete="off"
          />
          <button
            className={css.resetBtn}
            disabled={confirm !== MAGIC || resetting}
            onClick={handleReset}
          >
            {resetting ? 'Resetting…' : `Reset All Data for ${companyName}`}
          </button>
        </>
      )}
    </div>
  )
}

// ── Generic import section ────────────────────────────────────────────────────

interface ImportSectionProps<T extends { _error?: string; _line: number }> {
  title: string
  templateFile: string
  templateContent: string
  columns: { label: string; required?: boolean }[]
  formatNote?: string
  parseFile: (text: string) => T[]
  renderRow: (row: T) => React.ReactNode
  columnHeaders: string[]
  doImport: (rows: T[], onProgress: (done: number, total: number) => void) => Promise<ImportResult>
}

function ImportSection<T extends { _error?: string; _line: number; name: string }>({
  title, templateFile, templateContent, columns, formatNote,
  parseFile, renderRow, columnHeaders, doImport,
}: ImportSectionProps<T>) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName]   = useState('')
  const [rows,     setRows]       = useState<T[]>([])
  const [progress, setProgress]   = useState<{ done: number; total: number } | null>(null)
  const [result,   setResult]     = useState<ImportResult | null>(null)
  const [error,    setError]      = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  const valid   = rows.filter(r => !r._error)
  const invalid = rows.filter(r => !!r._error)

  async function handleFile(file: File) {
    setFileName(file.name)
    setResult(null)
    setError(null)
    setProgress(null)
    try {
      const text = await readFileAsText(file)
      setRows(parseFile(text))
    } catch (e: unknown) {
      setError((e as Error).message)
    }
  }

  async function handleImport() {
    if (valid.length === 0) return
    setImporting(true)
    setError(null)
    setResult(null)
    setProgress({ done: 0, total: valid.length })
    try {
      const res = await doImport(valid, (done, total) => setProgress({ done, total }))
      setResult(res)
      if (res.errors.length === 0) {
        toast.success(`${res.imported} ${title.toLowerCase()} imported`)
      } else {
        toast.warning(`${res.imported} imported, ${res.skipped} failed`)
      }
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  return (
    <div className={css.importSection}>
      {/* Format guide */}
      <div className={css.formatBox}>
        <p className={css.formatTitle}>Expected CSV Columns</p>
        <div className={css.formatCols}>
          {columns.map(c => (
            <span key={c.label} className={c.required ? css.colBadgeRequired : css.colBadge}>
              {c.label}{c.required ? ' *' : ''}
            </span>
          ))}
        </div>
        {formatNote && <p className={css.formatNote}>{formatNote}</p>}
      </div>

      <button
        className={css.templateBtn}
        onClick={() => downloadCsvTemplate(templateFile, templateContent)}
      >
        ↓ Download Template CSV
      </button>

      {/* File upload */}
      <div
        className={css.uploadArea}
        onClick={() => fileRef.current?.click()}
        onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
        onDragOver={e => e.preventDefault()}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
        />
        <p className={css.uploadText}>Click to select a CSV file or drag and drop</p>
        {fileName && <p className={css.uploadFile}>{fileName}</p>}
      </div>

      {error && <div className={css.error}>{error}</div>}

      {/* Preview */}
      {rows.length > 0 && (
        <>
          <div className={css.previewHeader}>
            <strong style={{ fontSize: '0.875rem' }}>Preview ({rows.length} rows)</strong>
            <div className={css.previewStats}>
              <span className={css.statValid}>✓ {valid.length} valid</span>
              {invalid.length > 0 && <span className={css.statInvalid}>✗ {invalid.length} errors</span>}
            </div>
          </div>

          <div className={css.tableWrap}>
            <table className={css.table}>
              <thead>
                <tr>
                  <th>#</th>
                  {columnHeaders.map(h => <th key={h}>{h}</th>)}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 50).map((row, i) => (
                  <tr key={i} className={row._error ? css.rowError : undefined}>
                    <td style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>{row._line}</td>
                    {renderRow(row)}
                    <td>
                      {row._error
                        ? <><span className={css.statusErr}>✗</span><br /><span className={css.errorMsg}>{row._error}</span></>
                        : <span className={css.statusOk}>✓</span>
                      }
                    </td>
                  </tr>
                ))}
                {rows.length > 50 && (
                  <tr>
                    <td colSpan={columnHeaders.length + 2} style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.75rem', padding: '0.5rem' }}>
                      … and {rows.length - 50} more rows (all will be imported)
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {!importing && !result && (
            <button className={css.importBtn} disabled={valid.length === 0} onClick={handleImport}>
              Import {valid.length} {title}
            </button>
          )}
        </>
      )}

      {/* Progress */}
      {progress && (
        <div className={css.progressWrap}>
          <p className={css.progressLabel}>Importing… {progress.done} / {progress.total}</p>
          <div className={css.progressBar}>
            <div
              className={css.progressFill}
              style={{ width: `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className={css.resultBox}>
          <p className={css.resultTitle}>{title} Import Complete</p>
          <p className={css.resultRow}>
            <span className={css.resultImported}>✓ {result.imported} imported</span>
            {result.skipped > 0 && <span style={{ marginLeft: 12 }}><span className={css.resultSkipped}>⚠ {result.skipped} skipped</span></span>}
          </p>
          {result.errors.length > 0 && (
            <div className={css.errorList}>
              {result.errors.map((e, i) => (
                <div key={i} className={css.errorItem}>
                  Row {e.line}: <strong>{e.name}</strong> — {e.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Payment Accounts Management ───────────────────────────────────────────────

// ── blank form factory ────────────────────────────────────────────────────────
function blankAccountForm(companyId: string): Partial<CompanyPaymentAccount> {
  return { company_id: companyId, label: '', account_holder_name: null, bank_name: null,
           bank_account_number: null, bank_ifsc: null, upi_id: null, is_primary: false }
}

function PaymentAccountsManagement({ companyId }: { companyId: string }) {
  const [accounts,        setAccounts]        = useState<CompanyPaymentAccount[]>([])
  const [loaded,          setLoaded]          = useState(false)
  const [loading,         setLoading]         = useState(false)
  const [formOpen,        setFormOpen]        = useState(false)
  const [editingId,       setEditingId]       = useState<string | null>(null)
  const [form,            setForm]            = useState<Partial<CompanyPaymentAccount>>(() => blankAccountForm(companyId))
  const [saving,          setSaving]          = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const setField = (k: keyof CompanyPaymentAccount, v: unknown) =>
    setForm(prev => ({ ...prev, [k]: v }))

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setAccounts(await fetchCompanyPaymentAccounts(companyId))
      setLoaded(true)
    } catch (e: unknown) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [companyId])

  if (!loaded && !loading) { void load() }

  const openNew = () => {
    setEditingId(null)
    setForm(blankAccountForm(companyId))
    setFormOpen(true)
  }

  const openEdit = (acct: CompanyPaymentAccount) => {
    setEditingId(acct.id)
    setForm({ ...acct })
    setFormOpen(true)
  }

  const closeForm = () => { setFormOpen(false); setEditingId(null); setForm(blankAccountForm(companyId)) }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const label = (form.label ?? '').trim()
    if (!label) { toast.error('Label is required'); return }
    setSaving(true)
    try {
      const { supabase: sb } = await import('@/lib/supabase')
      const payload = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, v === '' ? null : v])
      )
      if (editingId) {
        const { error } = await sb
          .schema('registry').from('company_bank_accounts').update(payload).eq('id', editingId)
        if (error) throw new Error(error.message)
        toast.success('Account updated')
      } else {
        const { data, error } = await sb
          .schema('registry').from('company_bank_accounts').insert(payload).select().single()
        if (error) throw new Error(error.message)
        setAccounts(prev => [...prev, data as CompanyPaymentAccount])
        closeForm()
        toast.success('Account added')
        setSaving(false)
        return
      }
      setAccounts(await fetchCompanyPaymentAccounts(companyId))
      closeForm()
    } catch (e: unknown) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteCompanyPaymentAccount(id)
      setAccounts(prev => prev.filter(a => a.id !== id))
      setConfirmDeleteId(null)
      toast.success('Account removed')
    } catch (e: unknown) {
      toast.error((e as Error).message)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '0.5rem 0.75rem', background: 'var(--surface)',
    border: '1px solid var(--border-2)', borderRadius: '6px', color: 'var(--text)',
    fontSize: '0.875rem', fontFamily: 'inherit', boxSizing: 'border-box',
  }
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem',
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '1.25rem', lineHeight: 1.6 }}>
        Manage "Pay From" bank accounts for this company. These appear in the Pay Now modal
        and voucher entry. Bank details (account number, IFSC, UPI) are stored in the shared
        registry so all Relish apps can use them.
      </p>

      {!formOpen && (
        <button onClick={openNew} className={css.importBtn} style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', margin: '0 0 1.25rem' }}>
          + Add Account
        </button>
      )}

      {/* Add / Edit form */}
      {formOpen && (
        <form onSubmit={handleSave} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '1.25rem', marginBottom: '1.5rem' }}>
          <p style={{ margin: '0 0 1rem', fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)' }}>
            {editingId ? 'Edit Account' : 'New Account'}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Label *</label>
              <input style={inputStyle} value={form.label ?? ''} onChange={e => setField('label', e.target.value)} placeholder="e.g. RHHF HDFC Current A/C" maxLength={120} autoFocus />
            </div>
            <div>
              <label style={labelStyle}>Account Holder Name</label>
              <input style={inputStyle} value={form.account_holder_name ?? ''} onChange={e => setField('account_holder_name', e.target.value)} placeholder="As per bank records" />
            </div>
            <div>
              <label style={labelStyle}>Bank Name</label>
              <input style={inputStyle} value={form.bank_name ?? ''} onChange={e => setField('bank_name', e.target.value)} placeholder="e.g. HDFC Bank" />
            </div>
            <div>
              <label style={labelStyle}>Account Number</label>
              <input style={inputStyle} value={form.bank_account_number ?? ''} onChange={e => setField('bank_account_number', e.target.value)} placeholder="Account number" />
            </div>
            <div>
              <label style={labelStyle}>IFSC Code</label>
              <input style={inputStyle} value={form.bank_ifsc ?? ''} onChange={e => setField('bank_ifsc', e.target.value.toUpperCase())} placeholder="e.g. HDFC0001234" maxLength={11} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>UPI ID</label>
              <input style={inputStyle} value={form.upi_id ?? ''} onChange={e => setField('upi_id', e.target.value)} placeholder="e.g. relishfoods@hdfcbank" />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!form.is_primary} onChange={e => setField('is_primary', e.target.checked)} />
                Set as primary
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <button type="submit" disabled={saving || !form.label?.trim()} className={css.importBtn} style={{ padding: '0.5rem 1.25rem', fontSize: '0.875rem', margin: 0 }}>
              {saving ? 'Saving…' : (editingId ? 'Update' : 'Add Account')}
            </button>
            <button type="button" onClick={closeForm} style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', background: 'none', border: '1px solid var(--border-2)', borderRadius: '6px', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* List */}
      {loading && <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Loading…</p>}
      {!loading && accounts.length === 0 && !formOpen && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>No accounts added yet.</p>
      )}
      {accounts.map(a => (
        <div key={a.id} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem', padding: '0.75rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '0.5rem' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
              <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)' }}>{a.label}</span>
              {a.is_primary && <span style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem', background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.4)', borderRadius: '4px', color: '#22c55e' }}>Primary</span>}
            </div>
            <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              {a.bank_name && <span>{a.bank_name}</span>}
              {a.bank_account_number && <span> · A/C {a.bank_account_number}</span>}
              {a.bank_ifsc && <span> · IFSC {a.bank_ifsc}</span>}
              {a.upi_id && <div>UPI: {a.upi_id}</div>}
              {a.account_holder_name && <div>{a.account_holder_name}</div>}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
            {confirmDeleteId === a.id ? (
              <>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Remove?</span>
                <button onClick={() => handleDelete(a.id)} style={{ padding: '0.25rem 0.625rem', fontSize: '0.75rem', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '5px', color: '#ef4444', cursor: 'pointer', fontFamily: 'inherit' }}>Yes</button>
                <button onClick={() => setConfirmDeleteId(null)} style={{ padding: '0.25rem 0.625rem', fontSize: '0.75rem', background: 'none', border: '1px solid var(--border-2)', borderRadius: '5px', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
              </>
            ) : (
              <>
                <button onClick={() => openEdit(a)} style={{ padding: '0.25rem 0.625rem', fontSize: '0.75rem', background: 'none', border: '1px solid var(--border)', borderRadius: '5px', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>Edit</button>
                <button onClick={() => setConfirmDeleteId(a.id)} style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', background: 'none', border: '1px solid var(--border)', borderRadius: '5px', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>Remove</button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Tab = 'reset' | 'groups' | 'ledgers' | 'payments'

export default function AdminPanel() {
  const { user } = useAuth()
  const company   = user?.activeCompany
  const companyId = company?.id ?? ''

  const [tab, setTab] = useState<Tab>('reset')

  if (!user?.profile.is_super_admin) {
    return (
      <div className={css.page}>
        <div className={css.error}>Super Admin access required.</div>
      </div>
    )
  }

  const groupImport = useCallback(
    (rows: LedgerGroupRow[], onProgress: (d: number, t: number) => void) =>
      importLedgerGroups(companyId, rows, onProgress),
    [companyId],
  )

  const ledgerImport = useCallback(
    (rows: LedgerRow[], onProgress: (d: number, t: number) => void) =>
      importLedgers(companyId, rows, onProgress),
    [companyId],
  )

  return (
    <div className={css.page}>
      <div className={css.header}>
        <h1 className={css.title}>Admin Panel</h1>
        <p className={css.subtitle}>
          Super Admin only · Active company: <strong>{company?.name ?? '—'}</strong>
        </p>
      </div>

      <div className={css.tabs}>
        <button
          className={tab === 'reset' ? css.tabDangerActive : css.tabDanger}
          onClick={() => setTab('reset')}
        >
          ⚠ Data Reset
        </button>
        <button
          className={tab === 'groups' ? css.tabActive : css.tab}
          onClick={() => setTab('groups')}
        >
          Import: Ledger Groups
        </button>
        <button
          className={tab === 'ledgers' ? css.tabActive : css.tab}
          onClick={() => setTab('ledgers')}
        >
          Import: Ledgers
        </button>
        <button
          className={tab === 'payments' ? css.tabActive : css.tab}
          onClick={() => setTab('payments')}
        >
          Pay-From Accounts
        </button>
      </div>

      {tab === 'reset' && (
        <DataReset companyId={companyId} companyName={company?.name ?? ''} />
      )}

      {tab === 'groups' && (
        <ImportSection<LedgerGroupRow>
          title="Ledger Groups"
          templateFile="pramaana_ledger_groups_template.csv"
          templateContent={LEDGER_GROUPS_TEMPLATE}
          columns={[
            { label: 'Group Name',        required: true  },
            { label: 'Parent Group Name', required: false },
            { label: 'Nature',            required: true  },
          ]}
          formatNote={
            'Nature must be: ASSET, LIABILITY, INCOME, or EXPENSE. ' +
            'Parent Group Name can be a system group (e.g. "Fixed Assets", "Indirect Expenses") ' +
            'or any group in this same file. Leave blank for top-level groups.'
          }
          parseFile={parseLedgerGroupsCsv}
          columnHeaders={['Group Name', 'Parent Group', 'Nature']}
          renderRow={row => (
            <>
              <td>{row.name}</td>
              <td style={{ color: 'var(--text-muted)' }}>{row.parent_name || '—'}</td>
              <td>{row.nature}</td>
            </>
          )}
          doImport={groupImport}
        />
      )}

      {tab === 'ledgers' && (
        <ImportSection<LedgerRow>
          title="Ledgers"
          templateFile="pramaana_ledgers_template.csv"
          templateContent={LEDGERS_TEMPLATE}
          columns={[
            { label: 'Ledger Name',          required: true  },
            { label: 'Group Name',           required: true  },
            { label: 'Opening Balance',      required: false },
            { label: 'Dr/Cr',               required: false },
            { label: 'GSTIN',               required: false },
            { label: 'Is Bank Account (Y/N)', required: false },
            { label: 'Bank Name',            required: false },
            { label: 'Account Number',       required: false },
            { label: 'IFSC',                 required: false },
          ]}
          formatNote={
            'Group Name must match an existing system group or a group you have already imported. ' +
            'Opening Balance: plain number without commas (e.g. 150000). ' +
            'Dr/Cr: Dr for debit balance, Cr for credit balance.'
          }
          parseFile={parseLedgersCsv}
          columnHeaders={['Ledger Name', 'Group', 'Balance', 'Dr/Cr', 'Bank?']}
          renderRow={row => (
            <>
              <td>{row.name}</td>
              <td style={{ color: 'var(--text-muted)' }}>{row.group_name}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                {row.opening_balance > 0
                  ? new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2 }).format(row.opening_balance)
                  : '0.00'
                }
              </td>
              <td>{row.dr_cr}</td>
              <td>{row.is_bank_account ? 'Y' : 'N'}</td>
            </>
          )}
          doImport={ledgerImport}
        />
      )}

      {tab === 'payments' && (
        <PaymentAccountsManagement companyId={companyId} />
      )}
    </div>
  )
}
