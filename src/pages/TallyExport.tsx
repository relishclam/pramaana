import { useState, useEffect, useCallback } from 'react'
import { CheckCircle2, XCircle, AlertTriangle, Download, RefreshCw, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchLedgerMaps,
  fetchTallyMasterRows,
  upsertTallyMasterRows,
  upsertLedgerMap,
  setMapVerified,
  deleteLedgerMap,
  runAutoMatch,
  validateExport,
  generateTallyXML,
  downloadTallyXML,
  parseTallyMasterCSV,
  type TallyLedgerMap,
  type ValidationError,
  type ExportManifest,
} from '@/lib/tally-export'
import css from './TallyExport.module.css'

type SubTab = 'masters' | 'mapping' | 'export'

// ── Helpers ───────────────────────────────────────────────────────────────────

const ENTITY_TYPE_LABELS: Record<string, string> = {
  party:        'Party / Entity',
  gl_account:   'GL Account',
  gst_ledger:   'GST Ledger',
  bank_ledger:  'Bank Ledger',
  cash_ledger:  'Cash Ledger',
}

// ── Tab 1: Tally Master Import ────────────────────────────────────────────────

function MastersTab({ companyId }: { companyId: string }) {
  const [csv,       setCsv]       = useState('')
  const [preview,   setPreview]   = useState<{ name: string; group: string | null }[]>([])
  const [importing, setImporting] = useState(false)
  const [matching,  setMatching]  = useState(false)
  const [matchResult, setMatchResult] = useState<{
    exact: number
    fuzzy: { pramaana: string; tally: string; score: number }[]
  } | null>(null)

  const handleParse = () => {
    const rows = parseTallyMasterCSV(csv)
    setPreview(rows.map(r => ({ name: r.tally_name, group: r.tally_group })))
  }

  const handleImport = async () => {
    if (!preview.length) { toast.error('Parse the CSV first'); return }
    setImporting(true)
    try {
      const rows = parseTallyMasterCSV(csv)
      await upsertTallyMasterRows(companyId, rows)
      toast.success(`${rows.length} Tally ledgers imported`)
    } catch (e: unknown) {
      toast.error((e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  const handleAutoMatch = async () => {
    setMatching(true)
    try {
      const result = await runAutoMatch(companyId)
      setMatchResult(result)
      toast.success(`Auto-match done — ${result.exact} exact match(es) found`)
      if (result.errors.length) toast.warning(`${result.errors.length} error(s) — check results`)
    } catch (e: unknown) {
      toast.error((e as Error).message)
    } finally {
      setMatching(false)
    }
  }

  return (
    <div className={css.tabContent}>
      <p className={css.desc}>
        Paste the Tally ledger master list below (CSV format: <code>Name,Parent Group</code>).
        In Tally: <strong>Gateway → Display More Reports → List of Accounts → Export (Alt+E) → CSV</strong>.
        Then click <strong>Auto-Match</strong> to find exact name matches against Pramaana.
      </p>

      <div className={css.field}>
        <label className={css.label}>Tally Ledger Master CSV <span className={css.req}>*</span></label>
        <textarea
          className={css.textarea}
          rows={10}
          value={csv}
          onChange={e => setCsv(e.target.value)}
          placeholder={'Name,Parent Group,Opening Balance\nCanara Bank,Bank Accounts,250000\nCash in Hand,Cash in Hand,15000\n...'}
        />
      </div>

      <div className={css.btnRow}>
        <button className={css.btnSecondary} onClick={handleParse} disabled={!csv.trim()}>
          Preview ({preview.length} rows)
        </button>
        <button className={css.btnPrimary} onClick={handleImport} disabled={importing || !preview.length}>
          {importing ? <Loader2 size={13} className={css.spin} /> : null}
          Import {preview.length} Ledgers
        </button>
        <button className={css.btnPrimary} onClick={handleAutoMatch} disabled={matching}>
          {matching ? <Loader2 size={13} className={css.spin} /> : <RefreshCw size={13} />}
          Auto-Match → Mapping Tab
        </button>
      </div>

      {preview.length > 0 && (
        <div className={css.previewTable}>
          <div className={css.tableHead}>
            <span>Tally Ledger Name</span>
            <span>Parent Group</span>
          </div>
          {preview.slice(0, 20).map((r, i) => (
            <div key={i} className={css.tableRow}>
              <span>{r.name}</span>
              <span className={css.muted}>{r.group ?? '—'}</span>
            </div>
          ))}
          {preview.length > 20 && (
            <div className={css.tableRow}><span className={css.muted}>…and {preview.length - 20} more</span></div>
          )}
        </div>
      )}

      {matchResult && (
        <div className={css.matchResult}>
          <strong>{matchResult.exact}</strong> exact match(es) added to Mapping tab (unverified).
          {matchResult.fuzzy.length > 0 && (
            <>
              <br />
              <strong>{matchResult.fuzzy.length}</strong> fuzzy suggestion(s) — add these manually in the Mapping tab:
              <ul className={css.fuzzyList}>
                {matchResult.fuzzy.map((f, i) => (
                  <li key={i}>
                    <em>{f.pramaana}</em> → <strong>{f.tally}</strong>
                    {' '}({Math.round(f.score * 100)}% match)
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Tab 2: Ledger Mapping Review ──────────────────────────────────────────────

function MappingTab({ companyId }: { companyId: string }) {
  const [maps,   setMaps]   = useState<TallyLedgerMap[]>([])
  const [loading, setLoading] = useState(true)
  const [filter,  setFilter]  = useState<'all' | 'unverified' | 'verified'>('all')
  const [editId,  setEditId]  = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editGroup, setEditGroup] = useState('')
  const [newRow, setNewRow]   = useState<{
    display: string; tally: string; group: string; type: string
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setMaps(await fetchLedgerMaps(companyId))
    } catch (e: unknown) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [companyId])

  useEffect(() => { load() }, [load])

  const handleVerify = async (id: string, verified: boolean) => {
    try {
      await setMapVerified(id, verified)
      setMaps(prev => prev.map(m => m.id === id ? { ...m, is_verified: verified } : m))
    } catch (e: unknown) {
      toast.error((e as Error).message)
    }
  }

  const handleSaveEdit = async (map: TallyLedgerMap) => {
    try {
      await upsertLedgerMap({ ...map, tally_ledger_name: editName, tally_parent_group: editGroup || null, is_verified: false })
      setMaps(prev => prev.map(m => m.id === map.id ? { ...m, tally_ledger_name: editName, tally_parent_group: editGroup || null, is_verified: false } : m))
      setEditId(null)
      toast.success('Mapping updated — re-verify after changing the name')
    } catch (e: unknown) {
      toast.error((e as Error).message)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteLedgerMap(id)
      setMaps(prev => prev.filter(m => m.id !== id))
    } catch (e: unknown) {
      toast.error((e as Error).message)
    }
  }

  const handleAddNew = async () => {
    if (!newRow?.display || !newRow?.tally) { toast.error('Fill in both names'); return }
    try {
      await upsertLedgerMap({
        company_id:            companyId,
        pramaana_entity_type:  (newRow.type as TallyLedgerMap['pramaana_entity_type']) ?? 'gl_account',
        pramaana_entity_id:    null,
        pramaana_display_name: newRow.display,
        tally_ledger_name:     newRow.tally,
        tally_parent_group:    newRow.group || null,
        is_verified:           false,
        notes:                 'Added manually',
      })
      setNewRow(null)
      await load()
      toast.success('Mapping added — verify it after review')
    } catch (e: unknown) {
      toast.error((e as Error).message)
    }
  }

  const shown = maps.filter(m =>
    filter === 'all' ? true :
    filter === 'unverified' ? !m.is_verified :
    m.is_verified
  )

  const unverifiedCount = maps.filter(m => !m.is_verified).length

  if (loading) return <div className={css.loading}><Loader2 size={14} className={css.spin} /> Loading mappings…</div>

  return (
    <div className={css.tabContent}>
      <div className={css.mappingHeader}>
        <p className={css.desc} style={{ margin: 0 }}>
          {maps.length} mapping(s) total · <strong style={{ color: unverifiedCount ? 'var(--warning, #b45309)' : 'var(--success)' }}>{unverifiedCount} unverified</strong>.
          Every mapping must be verified before export.
        </p>
        <div className={css.filterRow}>
          {(['all', 'unverified', 'verified'] as const).map(f => (
            <button key={f} className={filter === f ? css.filterActive : css.filterBtn} onClick={() => setFilter(f)}>
              {f === 'all' ? `All (${maps.length})` : f === 'unverified' ? `Unverified (${unverifiedCount})` : `Verified (${maps.length - unverifiedCount})`}
            </button>
          ))}
        </div>
      </div>

      <div className={css.mappingTable}>
        <div className={css.mapHead}>
          <span>Pramaana Name</span>
          <span>Type</span>
          <span>Tally Ledger Name</span>
          <span>Tally Group</span>
          <span>Verified</span>
          <span />
        </div>

        {shown.map(map => (
          <div key={map.id} className={`${css.mapRow} ${!map.is_verified ? css.mapRowUnverified : ''}`}>
            <span className={css.mapPramaana}>{map.pramaana_display_name}</span>
            <span className={css.mapType}>{ENTITY_TYPE_LABELS[map.pramaana_entity_type] ?? map.pramaana_entity_type}</span>
            {editId === map.id ? (
              <>
                <input className={css.mapInput} value={editName} onChange={e => setEditName(e.target.value)} autoFocus />
                <input className={css.mapInput} value={editGroup} onChange={e => setEditGroup(e.target.value)} placeholder="parent group" />
                <span />
                <div className={css.mapActions}>
                  <button className={css.btnSm} onClick={() => handleSaveEdit(map)}>Save</button>
                  <button className={css.btnSmGhost} onClick={() => setEditId(null)}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <span className={css.mapTally}>
                  {map.tally_ledger_name}
                  {/* Warn if multiple Pramaana entries share this Tally ledger name
                      (fine for GST ledgers; a collision between two parties is an error) */}
                  {maps.filter(m => m.tally_ledger_name === map.tally_ledger_name && m.id !== map.id).length > 0 && (
                    <span
                      className={css.dupWarn}
                      title={`${maps.filter(m => m.tally_ledger_name === map.tally_ledger_name && m.id !== map.id).length} other mapping(s) point to this same Tally ledger — verify this is intentional (ok for GST ledgers, not ok for parties)`}
                    >
                      ⚠
                    </span>
                  )}
                </span>
                <span className={css.muted}>{map.tally_parent_group ?? '—'}</span>
                <button
                  className={map.is_verified ? css.verifyBtnOn : css.verifyBtnOff}
                  onClick={() => handleVerify(map.id, !map.is_verified)}
                  title={map.is_verified ? 'Click to un-verify' : 'Click to verify'}
                >
                  {map.is_verified ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                  {map.is_verified ? 'Verified' : 'Unverified'}
                </button>
                <div className={css.mapActions}>
                  <button className={css.btnSmGhost} onClick={() => { setEditId(map.id); setEditName(map.tally_ledger_name); setEditGroup(map.tally_parent_group ?? '') }}>Edit</button>
                  <button className={css.btnSmDanger} onClick={() => handleDelete(map.id)}>×</button>
                </div>
              </>
            )}
          </div>
        ))}

        {shown.length === 0 && (
          <div className={css.mapEmpty}>
            {filter === 'all' ? 'No mappings yet. Run Auto-Match in the Import tab first.' : `No ${filter} mappings.`}
          </div>
        )}
      </div>

      {/* Add mapping manually */}
      {newRow ? (
        <div className={css.addRow}>
          <input className={css.mapInput} placeholder="Pramaana display name" value={newRow.display} onChange={e => setNewRow(r => r ? { ...r, display: e.target.value } : r)} />
          <select className={css.mapSelect} value={newRow.type} onChange={e => setNewRow(r => r ? { ...r, type: e.target.value } : r)}>
            {Object.entries(ENTITY_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input className={css.mapInput} placeholder="Exact Tally ledger name" value={newRow.tally} onChange={e => setNewRow(r => r ? { ...r, tally: e.target.value } : r)} />
          <input className={css.mapInput} placeholder="Tally parent group (optional)" value={newRow.group} onChange={e => setNewRow(r => r ? { ...r, group: e.target.value } : r)} />
          <button className={css.btnSm} onClick={handleAddNew}>Add</button>
          <button className={css.btnSmGhost} onClick={() => setNewRow(null)}>Cancel</button>
        </div>
      ) : (
        <button className={css.btnSecondary} style={{ marginTop: '1rem' }} onClick={() => setNewRow({ display: '', tally: '', group: '', type: 'gl_account' })}>
          + Add mapping manually
        </button>
      )}
    </div>
  )
}

// ── Tab 3: Export XML ─────────────────────────────────────────────────────────

function ExportTab({ companyId, companyCode }: { companyId: string; companyCode: string }) {
  const today     = new Date().toISOString().slice(0, 10)
  const [tallyName,  setTallyName]  = useState('')
  const [dateFrom,   setDateFrom]   = useState('2025-04-01')
  const [dateTo,     setDateTo]     = useState('2026-07-30')
  const [validating, setValidating] = useState(false)
  const [errors,     setErrors]     = useState<ValidationError[] | null>(null)
  const [exporting,  setExporting]  = useState(false)
  const [manifest,   setManifest]   = useState<ExportManifest | null>(null)

  const blockingErrors = (errors ?? []).filter(e => e.severity === 'error')

  const handleValidate = async () => {
    if (!tallyName.trim()) { toast.error('Enter the Tally company name first'); return }
    setValidating(true)
    setErrors(null)
    try {
      const errs = await validateExport(companyId, dateFrom, dateTo)
      setErrors(errs)
      if (errs.filter(e => e.severity === 'error').length === 0) {
        toast.success('Pre-flight passed — ready to export')
      } else {
        toast.error(`${errs.filter(e => e.severity === 'error').length} blocking error(s) — fix before export`)
      }
    } catch (e: unknown) {
      toast.error((e as Error).message)
    } finally {
      setValidating(false)
    }
  }

  const handleExport = async () => {
    if (!tallyName.trim()) { toast.error('Enter the Tally company name first'); return }
    if (blockingErrors.length) { toast.error('Fix all errors before exporting'); return }
    setExporting(true)
    try {
      const { xml, manifest: mf } = await generateTallyXML(companyId, tallyName, dateFrom, dateTo)
      setManifest(mf)
      downloadTallyXML(xml, companyCode, dateFrom, dateTo)
      toast.success(`Downloaded — ${mf.voucher_count} vouchers · ₹${mf.total_debit_inr.toLocaleString('en-IN', { maximumFractionDigits: 0 })} total Dr`)
    } catch (e: unknown) {
      toast.error((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className={css.tabContent}>
      <p className={css.desc}>
        Exports all <strong>Posted</strong> vouchers in the date range as Tally Prime XML.
        Run <strong>Pre-flight Check</strong> first — it fails loud on any unresolved ledger mapping or unbalanced voucher.
        Test import on a throwaway Tally company before touching production.
      </p>

      <div className={css.exportForm}>
        <div className={css.field}>
          <label className={css.label}>
            Tally Company Name <span className={css.req}>*</span>
            <span className={css.hint}> — EXACT string as configured in Tally (case-sensitive)</span>
          </label>
          <input
            className={css.input}
            value={tallyName}
            onChange={e => setTallyName(e.target.value)}
            placeholder='e.g. "Relish Hao Hao Chi Foods"'
          />
        </div>

        <div className={css.row2}>
          <div className={css.field}>
            <label className={css.label}>Date From <span className={css.req}>*</span></label>
            <input type="date" className={css.input} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div className={css.field}>
            <label className={css.label}>Date To <span className={css.req}>*</span></label>
            <input type="date" className={css.input} value={dateTo} onChange={e => { setDateTo(e.target.value); setErrors(null) }} max={today} />
          </div>
        </div>

        <div className={css.btnRow}>
          <button className={css.btnSecondary} onClick={handleValidate} disabled={validating}>
            {validating ? <Loader2 size={13} className={css.spin} /> : <AlertTriangle size={13} />}
            Pre-flight Check
          </button>
          <button
            className={css.btnExport}
            onClick={handleExport}
            disabled={exporting || blockingErrors.length > 0 || errors === null}
          >
            {exporting ? <Loader2 size={13} className={css.spin} /> : <Download size={13} />}
            Download XML
          </button>
        </div>
      </div>

      {/* Validation results */}
      {errors !== null && (
        <div className={css.validationResults}>
          {errors.length === 0 ? (
            <div className={css.validOk}><CheckCircle2 size={14} /> All checks passed. Ready to export.</div>
          ) : (
            errors.map((err, i) => (
              <div key={i} className={err.severity === 'error' ? css.validError : css.validWarn}>
                {err.severity === 'error' ? <XCircle size={13} /> : <AlertTriangle size={13} />}
                <div>
                  <strong>{err.message}</strong>
                  {err.affected.length > 0 && (
                    <ul className={css.affectedList}>
                      {err.affected.slice(0, 10).map((a, j) => <li key={j}>{a}</li>)}
                      {err.affected.length > 10 && <li>…and {err.affected.length - 10} more</li>}
                    </ul>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Last manifest */}
      {manifest && (
        <div className={css.manifest}>
          <div className={css.manifestTitle}>Last export manifest</div>
          <div className={css.manifestGrid}>
            <span>Company</span><span>{manifest.tally_company}</span>
            <span>Date range</span><span>{manifest.date_from} → {manifest.date_to}</span>
            <span>Vouchers</span><span>{manifest.voucher_count}</span>
            {Object.entries(manifest.by_nature).map(([n, c]) => (
              <><span>  {n}</span><span>{c}</span></>
            ))}
            <span>Total Dr (INR)</span><span>₹ {manifest.total_debit_inr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
            <span>Generated</span><span>{new Date(manifest.generated_at).toLocaleString('en-IN')}</span>
          </div>
          <p className={css.manifestNote}>
            After import: verify Trial Balance net = 0 in the test Tally company before running on production.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TallyExport() {
  const { user }  = useAuth()
  const companyId   = user?.activeCompany?.id   ?? ''
  const companyCode = user?.activeCompany?.code  ?? ''
  const [subTab, setSubTab] = useState<SubTab>('masters')

  if (!user?.profile.is_super_admin) {
    return (
      <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>
        Super Admin access required.
      </div>
    )
  }

  return (
    <div className={css.page}>
      <div className={css.header}>
        <h1 className={css.title}>Tally XML Export</h1>
        <p className={css.subtitle}>
          One-time historical migration · Super Admin only · Company: <strong>{user?.activeCompany?.name ?? '—'}</strong>
        </p>
        <div className={css.warning}>
          ⚠ This tool generates a one-time XML for importing historical vouchers into Tally Prime.
          Import into a <strong>test company first</strong>, verify the Trial Balance, then run on production.
          RHHF and RFPL must be exported and imported <strong>separately</strong>.
        </div>
      </div>

      <div className={css.subTabs}>
        <button className={subTab === 'masters' ? css.subTabActive : css.subTab} onClick={() => setSubTab('masters')}>
          1 · Import Tally Masters
        </button>
        <button className={subTab === 'mapping' ? css.subTabActive : css.subTab} onClick={() => setSubTab('mapping')}>
          2 · Review Mapping
        </button>
        <button className={subTab === 'export' ? css.subTabActive : css.subTab} onClick={() => setSubTab('export')}>
          3 · Export XML
        </button>
      </div>

      {subTab === 'masters' && <MastersTab companyId={companyId} />}
      {subTab === 'mapping' && <MappingTab companyId={companyId} />}
      {subTab === 'export'  && <ExportTab  companyId={companyId} companyCode={companyCode} />}
    </div>
  )
}
