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
  fetchPeriodLock,
  setPeriodLock,
  clearPeriodLock,
  LEDGER_GROUPS_TEMPLATE,
  LEDGERS_TEMPLATE,
  type ResetPreview,
  type LedgerGroupRow,
  type LedgerRow,
  type ImportResult,
  type PeriodLock,
} from '@/lib/admin'
import {
  fetchCompanyPaymentAccounts,
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

function PaymentAccountsManagement({ companyId }: { companyId: string }) {
  const [accounts, setAccounts] = useState<CompanyPaymentAccount[]>([])
  const [loaded,   setLoaded]   = useState(false)
  const [loading,  setLoading]  = useState(false)

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

  return (
    <div style={{ maxWidth: 600 }}>
      {/* Source notice */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', padding: '0.875rem 1rem', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '8px', marginBottom: '1.5rem' }}>
        <span style={{ fontSize: '1rem', flexShrink: 0 }}>ℹ️</span>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
          These accounts are managed in{' '}
          <strong style={{ color: 'var(--text)' }}>Relish Suite → Master Data → Company Profiles</strong>.
          Click a company row, then use the <em>Bank Accounts</em> section to add, edit, or remove accounts.
          Changes appear here immediately.
        </p>
      </div>

      {loading && <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Loading…</p>}
      {!loading && accounts.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>No bank accounts found. Add them in Relish Suite → Company Profiles.</p>
      )}
      {accounts.map(a => (
        <div key={a.id} style={{ padding: '0.75rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '0.5rem' }}>
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
      ))}
    </div>
  )
}

// ── Period Lock management ────────────────────────────────────────────────────

function PeriodLockManagement({ companyId, userId }: { companyId: string; userId: string }) {
  const [lock,       setLock]       = useState<PeriodLock | null | undefined>(undefined)
  const [loading,    setLoading]    = useState(true)
  const [saving,     setSaving]     = useState(false)
  const [lockDate,   setLockDate]   = useState('')
  const [lockNote,   setLockNote]   = useState('')
  const [confirming, setConfirming] = useState(false)

  useState(() => {
    fetchPeriodLock(companyId)
      .then(l => { setLock(l); setLoading(false) })
      .catch(e => { toast.error(e.message); setLoading(false) })
  })

  async function handleLock() {
    if (!lockDate) { toast.error('Select a lock date'); return }
    setSaving(true)
    try {
      await setPeriodLock(companyId, lockDate, userId, lockNote || undefined)
      const updated = await fetchPeriodLock(companyId)
      setLock(updated)
      setConfirming(false)
      setLockNote('')
      toast.success('Period locked to ' + new Date(lockDate + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }))
    } catch (e: unknown) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleUnlock() {
    setSaving(true)
    try {
      await clearPeriodLock(companyId)
      setLock(null)
      setLockDate('')
      toast.success('Period unlocked')
    } catch (e: unknown) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className={css.empty}>Loading…</div>

  return (
    <div className={css.lockWrap}>
      <p className={css.lockDesc}>
        Vouchers dated <strong>on or before the lock date</strong> cannot be created,
        edited, or deleted. Use this after filing GST returns or year-end closing to
        protect historical data. Unlock at any time to make corrections, then re-lock.
      </p>

      {lock ? (
        <div className={css.lockStatus}>
          <div className={css.lockStatusIcon}>\ud83d\udd12</div>
          <div className={css.lockStatusBody}>
            <div className={css.lockStatusLabel}>Period locked</div>
            <div className={css.lockStatusDate}>
              All vouchers dated on or before{' '}
              <strong>
                {new Date(lock.lock_date + 'T00:00:00').toLocaleDateString('en-IN', {
                  day: 'numeric', month: 'long', year: 'numeric',
                })}
              </strong>{' '}
              are protected.
            </div>
            {lock.note && <div className={css.lockNote}>\u201c{lock.note}\u201d</div>}
            <div className={css.lockMeta}>
              Locked {new Date(lock.locked_at).toLocaleDateString('en-IN', {
                day: 'numeric', month: 'short', year: 'numeric',
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className={css.lockStatus} style={{ opacity: 0.6 }}>
          <div className={css.lockStatusIcon}>\ud83d\udd13</div>
          <div className={css.lockStatusBody}>
            <div className={css.lockStatusLabel}>Unlocked</div>
            <div className={css.lockStatusDate}>All vouchers are editable.</div>
          </div>
        </div>
      )}

      <div className={css.lockActions}>
        {lock ? (
          <button
            className={css.lockUnlockBtn}
            onClick={handleUnlock}
            disabled={saving}
          >
            {saving ? <Loader2 size={13} className={css.spin} /> : null}
            Unlock Period
          </button>
        ) : confirming ? (
          <div className={css.lockConfirm}>
            <div className={css.lockConfirmRow}>
              <div className={css.field}>
                <label className={css.fieldLabel}>
                  Lock all vouchers dated on or before <span className={css.req}>*</span>
                </label>
                <input
                  type="date"
                  className={css.input}
                  value={lockDate}
                  onChange={e => setLockDate(e.target.value)}
                />
              </div>
            </div>
            <div className={css.lockConfirmRow}>
              <div className={css.field}>
                <label className={css.fieldLabel}>
                  Reason <span className={css.fieldOpt}>(optional, e.g. "Q2 FY2627 GST filed")</span>
                </label>
                <input
                  className={css.input}
                  value={lockNote}
                  onChange={e => setLockNote(e.target.value)}
                  placeholder='e.g. "FY2526 year-end closed"'
                />
              </div>
            </div>
            <div className={css.lockConfirmBtns}>
              <button className={css.lockCancelBtn} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className={css.lockApplyBtn} onClick={handleLock} disabled={saving || !lockDate}>
                {saving ? <Loader2 size={13} className={css.spin} /> : null}
                Lock Period
              </button>
            </div>
          </div>
        ) : (
          <button className={css.lockSetBtn} onClick={() => setConfirming(true)}>
            Set Lock Date\u2026
          </button>
        )}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Tab = 'reset' | 'groups' | 'ledgers' | 'payments' | 'lock'

export default function AdminPanel() {
  const { user } = useAuth()
  const company   = user?.activeCompany
  const companyId = company?.id ?? ''
  const userId    = user?.id ?? ''

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
          className={tab === 'lock' ? css.tabActive : css.tab}
          onClick={() => setTab('lock')}
        >
          🔒 Period Lock
        </button>
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

      {tab === 'lock' && (
        <PeriodLockManagement companyId={companyId} userId={userId} />
      )}
    </div>
  )
}
