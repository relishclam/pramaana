// ── New Autonomous Bank Reconciliation Page ──────────────────────────────────
// Replaces old 3-call architecture. Single POST /api/bank-recon-upload handles
// detect → parse → validate → match. No bank selector. No date pickers.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Upload, CheckCircle, AlertCircle, RefreshCw, X,
  Send, FileText, BarChart2, Loader, Trash2, Check,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import css from './BankRecon.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
const fmt = (n: number | null | undefined) => n == null ? '—' : inr.format(n)
const fmtDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { const r = reader.result as string; resolve(r.split(',')[1] ?? r) }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ── New status enum (recon_transactions.match_status CHECK constraint) ────────
const MATCH_STATUS_LABELS: Record<string, string> = {
  unmatched:      'Unmatched',
  auto_matched:   'Auto-matched',
  manual_matched: 'Confirmed',
  pending_review: 'Needs review',
  disputed:       'Disputed',
  written_off:    'Written off',
}

const MATCH_METHOD_LABELS: Record<string, string> = {
  exact:     'Exact',
  reference: 'VCH ref',
  fuzzy:     'Fuzzy',
  ai:        'AI',
  manual:    'Manual',
}

const MATCH_STATUS_CSS: Record<string, string> = {
  unmatched:      css.chipUnmatched,
  auto_matched:   css.chipMatched,
  manual_matched: css.chipConfirmed,
  pending_review: css.chipFuzzy,
  disputed:       css.chipQueried,
  written_off:    css.chipIgnored,
}

function StatusChip({ status }: { status: string }) {
  return (
    <span className={MATCH_STATUS_CSS[status] ?? css.chipUnmatched}>
      {MATCH_STATUS_LABELS[status] ?? status}
    </span>
  )
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface UploadSummary {
  bank: { code: string; name: string; confidence: number }
  account_number: string | null
  period_from: string; period_to: string
  txn_count: number; opening_balance: number; closing_balance: number
}
interface MatchResult {
  exact_matches: number; fuzzy_matches: number; ai_matches: number
  unmatched: number; queries_created: number
}
interface OverlapInfo {
  existing_statement_id: string
  existing_period_from: string; existing_period_to: string
  overlap_from: string; overlap_to: string
  duplicate_txn_count: number
}
interface ValidationResult {
  is_valid: boolean; opening_balance: number; closing_balance: number
  computed_closing: number
  discontinuities: { row: number; expected: number; actual: number }[]
}
interface ReconStatement {
  id: string; period_from: string; period_to: string
  opening_balance: number; closing_balance: number
  txn_count: number; upload_status: string
  file_name: string | null; created_at: string
  recon_bank_accounts: { bank_code: string; bank_name: string; account_number: string } | null
}
interface ReconTxn {
  id: string; row_number: number; txn_date: string
  narration: string; reference: string | null
  debit: number | null; credit: number | null; balance: number
  counterparty: string | null; match_status: string
  // PostgREST returns joined rows as an array even with UNIQUE constraint
  recon_matches: {
    id: string
    voucher_id: string
    match_method: string; match_confidence: number
    match_reason: string; is_confirmed: boolean
  }[] | null
}

// ── Upload Tab ────────────────────────────────────────────────────────────────

type Phase =
  | 'idle' | 'reading' | 'uploading' | 'detecting' | 'parsing'
  | 'validating' | 'matching' | 'done'
  | 'needs_bank' | 'overlap' | 'warn_validation' | 'error'

const PROGRESS_PHASES: Phase[] = ['uploading','detecting','parsing','validating','matching','done']
const PROGRESS_LABELS: Record<string, string> = {
  uploading: 'Uploading', detecting: 'Detecting bank',
  parsing: 'Parsing transactions', validating: 'Validating balances',
  matching: 'Running match engine', done: 'Done',
}

function UploadTab({ companyId, onComplete }: { companyId: string; onComplete: (id: string) => void }) {
  const [drag, setDrag]           = useState(false)
  const [phase, setPhase]         = useState<Phase>('idle')
  const [pasteMode, setPasteMode] = useState(false)
  const [pastedText, setPastedText] = useState('')
  const [error, setError]         = useState<string | null>(null)
  const [summary, setSummary]     = useState<UploadSummary | null>(null)
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null)
  const [overlap, setOverlap]     = useState<OverlapInfo | null>(null)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [storagePath, setStoragePath] = useState<string | null>(null)
  const [bankCandidates, setBankCandidates] = useState<{ code: string; name: string; confidence: number }[]>([])
  const [selectedBank, setSelectedBank] = useState('')
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [pendingStatementId, setPendingStatementId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setPhase('idle'); setError(null); setSummary(null); setMatchResult(null)
    setOverlap(null); setValidation(null); setStoragePath(null)
    setBankCandidates([]); setSelectedBank(''); setPendingFile(null); setPendingStatementId(null)
    setPastedText('')
  }

  const runUpload = useCallback(async (
    file: File | null,
    opts: { bankCode?: string; overlapResolution?: string; storagePath?: string } = {}
  ) => {
    setError(null)

    let b64: string
    let fileName: string
    let fileType: string

    if (pasteMode && !file) {
      if (!pastedText.trim()) { setError('Paste CSV data first'); return }
      setPhase('reading')
      const bytes = new TextEncoder().encode(pastedText)
      let binary = ''
      bytes.forEach(b => { binary += String.fromCharCode(b) })
      b64 = btoa(binary)
      fileName = 'pasted-statement.csv'
      fileType = 'text/csv'
    } else {
      if (!file) { setError('Select a file first'); return }
      setPhase('reading')
      try { b64 = await toBase64(file) }
      catch { setError('Failed to read file'); setPhase('error'); return }
      fileName = file.name
      fileType = file.type || fileName.split('.').pop() || 'application/octet-stream'
    }

    setPhase('uploading')
    const body: Record<string, unknown> = {
      company_id: companyId,
      file_base64: b64,
      file_name: fileName,
      file_type: fileType,
    }
    if (opts.bankCode)          body.bank_code          = opts.bankCode
    if (opts.overlapResolution) body.overlap_resolution = opts.overlapResolution
    if (opts.storagePath)       body.storage_path       = opts.storagePath

    let json: Record<string, unknown>
    try {
      setPhase('detecting')
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token ?? ''
      const res = await fetch('/api/bank-recon-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      json = await res.json() as Record<string, unknown>
    } catch {
      setError('Network error — check connection'); setPhase('error'); return
    }

    const status = json.status as string

    if (status === 'error') {
      setError((json.error as string) ?? 'Upload failed'); setPhase('error'); return
    }

    if (status === 'needs_bank_selection') {
      setBankCandidates((json.bank_candidates as typeof bankCandidates) ?? [])
      setPendingFile(file); setPhase('needs_bank'); return
    }

    if (status === 'overlap_detected') {
      setOverlap(json.overlap as OverlapInfo)
      setStoragePath((json.storage_path as string) ?? null)
      setPendingFile(file); setPhase('overlap'); return
    }

    // validation_warning: data IS already committed — statement_id is in the response
    if (status === 'validation_warning') {
      setValidation(json.validation as ValidationResult)
      setSummary(json.summary as UploadSummary)
      setMatchResult((json.match_result as MatchResult) ?? null)
      if (json.statement_id) setPendingStatementId(json.statement_id as string)
      setPhase('warn_validation')
      return
    }

    // success
    setPhase('matching')
    setSummary(json.summary as UploadSummary)
    setMatchResult((json.match_result as MatchResult) ?? null)
    setPhase('done')
    if (json.statement_id) onComplete(json.statement_id as string)
  }, [companyId, onComplete, pasteMode, pastedText])

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDrag(false)
    const f = e.dataTransfer.files[0]
    if (f) { reset(); runUpload(f) }
  }
  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) { reset(); runUpload(f) }
    if (fileRef.current) fileRef.current.value = ''
  }

  const inProgress = ['reading','uploading','detecting','parsing','validating','matching'].includes(phase)
  const currIdx = PROGRESS_PHASES.indexOf(phase as Phase)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 680 }}>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button className={!pasteMode ? css.btnPrimary : css.btnSecondary}
          style={{ fontSize: '0.8125rem', padding: '0.25rem 0.875rem' }}
          onClick={() => setPasteMode(false)}>
          Upload file
        </button>
        <button className={pasteMode ? css.btnPrimary : css.btnSecondary}
          style={{ fontSize: '0.8125rem', padding: '0.25rem 0.875rem' }}
          onClick={() => setPasteMode(true)}>
          Paste CSV
        </button>
      </div>

      {/* Drop zone / paste area — idle only */}
      {phase === 'idle' && !pasteMode && (
        <div
          className={`${css.dropZone} ${drag ? css.dropZoneActive : ''}`}
          onDragOver={e => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}>
          <Upload size={28} className={css.dropZoneIcon} />
          <span className={css.dropZoneText}>Drop CSV, XLSX or TSV here, or click to browse</span>
          <span className={css.dropZoneHint}>Bank, period and format detected automatically — no manual input needed</span>
          {/* Accept includes XLSX for HDFC statements */}
          <input ref={fileRef} type="file" hidden accept=".csv,.xlsx,.xls,.json,.tsv"
            onChange={handleInput} />
        </div>
      )}

      {phase === 'idle' && pasteMode && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <textarea
            className={css.input}
            style={{ minHeight: 180, fontFamily: 'monospace', fontSize: '0.75rem', resize: 'vertical' }}
            placeholder={"Paste CSV rows here (including the header row).\nExample: Txn Date,Value Date,Cheque No.,Description,Debit,Credit,Balance"}
            value={pastedText}
            onChange={e => setPastedText(e.target.value)}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className={css.btnPrimary} disabled={!pastedText.trim()}
              onClick={() => runUpload(null)}>
              Parse &amp; match
            </button>
          </div>
        </div>
      )}

      {/* Progress steps */}
      {inProgress && (
        <div className={css.card}>
          <div className={css.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            {PROGRESS_PHASES.map((step, idx) => {
              const done   = idx < currIdx
              const active = idx === currIdx
              return (
                <div key={step} className={css.progressRow}>
                  {done   && <CheckCircle size={15} className={css.progressStepDone} />}
                  {active && <Loader size={15} className={`${css.progressStepActive} ${css.spin}`} />}
                  {!done && !active && <div style={{ width: 15, height: 15, borderRadius: '50%', border: '1.5px solid var(--border-2)', flexShrink: 0 }} />}
                  <span className={done ? css.progressStepDone : active ? css.progressStepActive : css.progressStep}>
                    {PROGRESS_LABELS[step]}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Error */}
      {phase === 'error' && (
        <div className={css.validationFail}>
          <AlertCircle size={15} style={{ flexShrink: 0 }} />
          <div style={{ flex: 1 }}><strong>Upload failed</strong><br />{error}</div>
          <button className={css.btnGhost} onClick={reset}>Try again</button>
        </div>
      )}

      {/* Needs bank selection */}
      {phase === 'needs_bank' && (
        <div className={css.card}>
          <div className={css.cardHeader}><span className={css.cardLabel}>Bank not detected — please select</span></div>
          <div className={css.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', margin: 0 }}>
              Auto-detection confidence was too low. Select the bank and retry.
            </p>
            <select className={css.select} value={selectedBank} onChange={e => setSelectedBank(e.target.value)}>
              <option value="">— Select bank —</option>
              {(bankCandidates.length
                ? bankCandidates
                : ([
                    { code: 'HDFC',    name: 'HDFC Bank' },
                    { code: 'CANARA',  name: 'Canara Bank' },
                    { code: 'FEDERAL', name: 'Federal Bank' },
                    { code: 'SIB',     name: 'South Indian Bank' },
                    { code: 'ICICI',   name: 'ICICI Bank' },
                  ] as { code: string; name: string; confidence: number }[])
              ).map(b => (
                <option key={b.code} value={b.code}>{b.name}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className={css.btnPrimary} disabled={!selectedBank}
                onClick={() => runUpload(pendingFile, { bankCode: selectedBank })}>
                Parse with selected bank
              </button>
              <button className={css.btnSecondary} onClick={reset}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Overlap detected — two-round-trip flow */}
      {phase === 'overlap' && overlap && (
        <div className={css.card}>
          <div className={css.cardHeader}>
            <span className={css.cardLabel} style={{ color: 'var(--gold)' }}>⚠ Overlapping period detected</span>
          </div>
          <div className={css.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', margin: 0 }}>
              An existing statement covers{' '}
              <strong>{fmtDate(overlap.overlap_from)} – {fmtDate(overlap.overlap_to)}</strong>.
              {overlap.duplicate_txn_count > 0 && (
                <> {overlap.duplicate_txn_count} transactions overlap.</>
              )}
            </p>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-dim)', margin: 0 }}>
              Choose how to handle the overlap:
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button className={css.btnPrimary}
                onClick={() => runUpload(pendingFile, { overlapResolution: 'skip_duplicates', storagePath: storagePath ?? undefined })}>
                Skip duplicates
              </button>
              <button className={css.btnSecondary}
                onClick={() => runUpload(pendingFile, { overlapResolution: 'replace', storagePath: storagePath ?? undefined })}>
                Replace existing
              </button>
              <button className={css.btnSecondary}
                onClick={() => runUpload(pendingFile, { overlapResolution: 'merge', storagePath: storagePath ?? undefined })}>
                Merge
              </button>
              <button className={css.btnGhost} onClick={reset}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Validation warning — data already committed, statement_id available; just navigate */}
      {phase === 'warn_validation' && validation && (
        <div className={css.card}>
          <div className={css.cardHeader}>
            <span className={css.cardLabel} style={{ color: 'var(--gold)' }}>⚠ Balance discontinuities (statement uploaded)</span>
          </div>
          <div className={css.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', margin: 0 }}>
              {validation.discontinuities.length} row{validation.discontinuities.length !== 1 ? 's' : ''} where
              running balance doesn’t match. Computed closing:{' '}
              <strong>{fmt(validation.computed_closing)}</strong> vs statement:{' '}
              <strong>{fmt(validation.closing_balance)}</strong>.
              The statement has been uploaded. You can proceed to the workbench or cancel.
            </p>
            {validation.discontinuities.slice(0, 5).map(d => (
              <div key={d.row} style={{ fontSize: '0.8125rem', color: 'var(--text-dim)', paddingLeft: '0.75rem' }}>
                Row {d.row}: expected {fmt(d.expected)}, actual {fmt(d.actual)}
              </div>
            ))}
            {validation.discontinuities.length > 5 && (
              <div style={{ fontSize: '0.8125rem', color: 'var(--text-dim)', paddingLeft: '0.75rem' }}>
                …and {validation.discontinuities.length - 5} more
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {summary && (
                <button className={css.btnPrimary}
                  onClick={() => { if (pendingStatementId) onComplete(pendingStatementId) }}>
                  Go to workbench
                </button>
              )}
              <button className={css.btnSecondary} onClick={reset}>Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {/* Success summary */}
      {phase === 'done' && summary && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {/* Detected bank banner */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.75rem',
            padding: '0.625rem 0.875rem',
            background: 'rgba(74,158,158,0.08)',
            border: '1px solid rgba(74,158,158,0.25)',
            borderRadius: 'var(--radius)', fontSize: '0.875rem',
          }}>
            <CheckCircle size={15} style={{ color: 'var(--teal)', flexShrink: 0 }} />
            <span>
              <strong>{summary.bank.name}</strong>
              {' · '}{fmtDate(summary.period_from)} – {fmtDate(summary.period_to)}
              {summary.account_number && (
                <span style={{ color: 'var(--text-muted)' }}> · ···{summary.account_number.slice(-4)}</span>
              )}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
              {summary.bank.confidence}% confidence
            </span>
          </div>

          {/* Totals */}
          <div className={css.card}>
            <div className={css.statGrid}>
              <div className={css.stat}>
                <div className={css.statLabel}>Transactions</div>
                <div className={css.statValue}>{summary.txn_count}</div>
              </div>
              <div className={css.stat}>
                <div className={css.statLabel}>Opening</div>
                <div className={css.statValue} style={{ fontSize: '1rem' }}>{fmt(summary.opening_balance)}</div>
              </div>
              <div className={css.stat}>
                <div className={css.statLabel}>Closing</div>
                <div className={css.statValue} style={{ fontSize: '1rem' }}>{fmt(summary.closing_balance)}</div>
              </div>
              <div className={css.stat}>
                <div className={css.statLabel}>Net</div>
                <div className={`${css.statValue} ${(summary.closing_balance - summary.opening_balance) >= 0 ? css.statValueTeal : css.statValueError}`}
                  style={{ fontSize: '1rem' }}>
                  {fmt(summary.closing_balance - summary.opening_balance)}
                </div>
              </div>
            </div>
          </div>

          {/* Match results */}
          {matchResult && (
            <div className={css.card}>
              <div className={css.cardHeader}><span className={css.cardLabel}>Match results</span></div>
              <div className={css.statGrid}>
                <div className={css.stat}>
                  <div className={css.statLabel}>Auto-matched</div>
                  <div className={`${css.statValue} ${css.statValueSuccess}`}>{matchResult.exact_matches}</div>
                </div>
                <div className={css.stat}>
                  <div className={css.statLabel}>Needs review</div>
                  <div className={`${css.statValue} ${css.statValueAmber}`}>{matchResult.fuzzy_matches + matchResult.ai_matches}</div>
                </div>
                <div className={css.stat}>
                  <div className={css.statLabel}>Unmatched</div>
                  <div className={`${css.statValue} ${matchResult.unmatched > 0 ? css.statValueError : css.statValueSuccess}`}>{matchResult.unmatched}</div>
                </div>
                <div className={css.stat}>
                  <div className={css.statLabel}>Queries raised</div>
                  <div className={css.statValue}>{matchResult.queries_created}</div>
                </div>
              </div>
            </div>
          )}

          <button className={css.btnSecondary} onClick={reset} style={{ alignSelf: 'flex-start' }}>
            Upload another statement
          </button>
        </div>
      )}
    </div>
  )
}

// ── Statements Tab ────────────────────────────────────────────────────────────

function StatementsTab({ companyId, onSelect }: { companyId: string; onSelect: (id: string) => void }) {
  const [stmts, setStmts]     = useState<ReconStatement[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    supabase.schema('pramaana').from('recon_statements')
      .select('id, period_from, period_to, opening_balance, closing_balance, txn_count, upload_status, file_name, created_at, recon_bank_accounts(bank_code, bank_name, account_number)')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => { setStmts((data ?? []) as unknown as ReconStatement[]); setLoading(false) })
  }, [companyId])

  useEffect(() => { load() }, [load])

  const deleteStmt = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!window.confirm('Delete this statement and all its transactions, matches and queries? This cannot be undone.')) return
    setDeleting(id)
    // Optimistically remove so the UI clears immediately even before load() re-fetches
    setStmts(prev => prev.filter(s => s.id !== id))
    const { data: { session } } = await supabase.auth.refreshSession()
    await fetch(`/api/bank-recon-statements?id=${id}&company_id=${companyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
    })
    setDeleting(null)
    load()
  }

  const STATUS_CSS: Record<string, string> = {
    matched: css.chipMatched, parsed: css.chipConfirmed,
    processing: css.chipFuzzy, pending_overlap: css.chipQueried, error: css.chipUnbooked,
  }

  if (loading) return <div className={css.loading}><Loader size={16} className={css.spin} /> Loading…</div>
  if (!stmts.length) return (
    <div className={css.emptyState}>
      <FileText size={24} style={{ marginBottom: '0.5rem' }} />
      <p>No statements uploaded yet. Go to the Upload tab to add one.</p>
    </div>
  )

  return (
    <div className={css.card}>
      <div className={css.cardHeader}>
        <span className={css.cardLabel}>Uploaded statements</span>
        <button className={css.btnGhost} onClick={load}><RefreshCw size={13} /></button>
      </div>
      <div className={css.stmtList}>
        {stmts.map(s => {
          const ba = s.recon_bank_accounts
          return (
            <div key={s.id} className={css.stmtRow} onClick={() => onSelect(s.id)}>
              <span className={css.stmtBank}>{ba?.bank_code ?? '—'}</span>
              <span className={css.stmtPeriod}>
                {fmtDate(s.period_from)} – {fmtDate(s.period_to)}
                {ba?.account_number && (
                  <span style={{ color: 'var(--text-dim)', marginLeft: '0.5rem', fontSize: '0.75rem' }}>
                    ···{ba.account_number.slice(-4)}
                  </span>
                )}
              </span>
              <span className={css.stmtLines}>{s.txn_count} txns</span>
              <span className={css.stmtLines}>{fmt(s.closing_balance)}</span>
              <span className={`${css.chip} ${STATUS_CSS[s.upload_status] ?? css.chipUnmatched}`}>
                {s.upload_status.replace(/_/g, ' ')}
              </span>
              <button
                title="Delete statement"
                disabled={deleting === s.id}
                onClick={e => deleteStmt(s.id, e)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text-dim)', padding: '2px 4px',
                  borderRadius: 4, display: 'flex', alignItems: 'center', flexShrink: 0,
                }}
                onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--error)')}
                onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--text-dim)')}>
                {deleting === s.id
                  ? <Loader size={13} className={css.spin} />
                  : <Trash2 size={13} />}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Match Workbench Tab ───────────────────────────────────────────────────────

type MFilter = 'all' | 'unmatched' | 'pending_review' | 'auto_matched' | 'manual_matched' | 'disputed' | 'written_off'

function WorkbenchTab({ statementId, companyId }: { statementId: string; companyId: string }) {
  const [txns, setTxns]           = useState<ReconTxn[]>([])
  const [loading, setLoading]     = useState(true)
  const [filter, setFilter]       = useState<MFilter>('all')
  const [selected, setSelected]   = useState<ReconTxn | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [rerunning, setRerunning]   = useState(false)
  const [rerunError, setRerunError] = useState<string | null>(null)

  // Voucher detail for the selected match
  type VoucherDetail = { id: string; voucher_number: string; voucher_date: string; amount: number; narration: string | null; party: string | null }
  const [voucherDetail,  setVoucherDetail]  = useState<VoucherDetail | null>(null)
  const [voucherLoading, setVoucherLoading] = useState(false)

  // "Match to different voucher" search
  const [showPicker,     setShowPicker]     = useState(false)
  const [voucherSearch,  setVoucherSearch]  = useState('')
  const [searchResults,  setSearchResults]  = useState<VoucherDetail[]>([])
  const [searching,      setSearching]      = useState(false)
  const [pickedVoucher,  setPickedVoucher]  = useState<VoucherDetail | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    supabase.schema('pramaana').from('recon_transactions')
      .select('id, row_number, txn_date, narration, reference, debit, credit, balance, counterparty, match_status, recon_matches(id, voucher_id, match_method, match_confidence, match_reason, is_confirmed)')
      .eq('statement_id', statementId)
      .order('row_number')
      .limit(1000)
      .then(({ data }) => { setTxns((data ?? []) as unknown as ReconTxn[]); setLoading(false) })
  }, [statementId])

  useEffect(() => { load() }, [load])

  // Fetch proposed voucher details whenever the selected transaction changes
  useEffect(() => {
    setVoucherDetail(null); setShowPicker(false); setVoucherSearch(''); setSearchResults([]); setPickedVoucher(null)
    if (!selected) return
    const match = Array.isArray(selected.recon_matches) ? selected.recon_matches[0] ?? null : selected.recon_matches
    if (!match?.voucher_id) return
    setVoucherLoading(true)
    supabase.schema('pramaana').from('vouchers')
      .select('id, voucher_number, voucher_date, amount, narration, entity_id')
      .eq('id', match.voucher_id).single()
      .then(async ({ data }) => {
        if (!data) { setVoucherLoading(false); return }
        let party: string | null = null
        if (data.entity_id) {
          const { data: ent } = await supabase.schema('registry').from('entities')
            .select('display_name').eq('id', data.entity_id as string).single()
          party = (ent as { display_name: string } | null)?.display_name ?? null
        }
        setVoucherDetail({ id: data.id as string, voucher_number: data.voucher_number as string, voucher_date: data.voucher_date as string, amount: data.amount as number, narration: data.narration as string | null, party })
        setVoucherLoading(false)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])

  // Search vouchers by number for manual re-matching
  useEffect(() => {
    if (!voucherSearch.trim() || voucherSearch.length < 2) { setSearchResults([]); return }
    const term = voucherSearch.trim()
    setSearching(true)
    supabase.schema('pramaana').from('vouchers')
      .select('id, voucher_number, voucher_date, amount, narration, entity_id')
      .eq('company_id', companyId).eq('status', 'posted')
      .ilike('voucher_number', `%${term}%`)
      .order('voucher_date', { ascending: false }).limit(8)
      .then(async ({ data }) => {
        const rows = (data ?? []) as { id: string; voucher_number: string; voucher_date: string; amount: number; narration: string | null; entity_id: string | null }[]
        const entityIds = [...new Set(rows.map(r => r.entity_id).filter(Boolean) as string[])]
        const entMap = new Map<string, string>()
        if (entityIds.length) {
          const { data: ents } = await supabase.schema('registry').from('entities').select('id, display_name').in('id', entityIds)
          ;((ents ?? []) as { id: string; display_name: string }[]).forEach(e => entMap.set(e.id, e.display_name))
        }
        setSearchResults(rows.map(r => ({ id: r.id, voucher_number: r.voucher_number, voucher_date: r.voucher_date, amount: r.amount, narration: r.narration, party: r.entity_id ? (entMap.get(r.entity_id) ?? null) : null })))
        setSearching(false)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voucherSearch, companyId])

  const counts: Record<string, number> = {}
  txns.forEach(t => { counts[t.match_status] = (counts[t.match_status] ?? 0) + 1 })

  const visible = filter === 'all' ? txns : txns.filter(t => t.match_status === filter)

  const doAction = async (txnId: string, action: 'confirm' | 'reject' | 'write_off', correctVoucherId?: string) => {
    setConfirming(txnId)
    const { data: { session } } = await supabase.auth.refreshSession()
    const res = await fetch('/api/bank-recon-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify({ bank_txn_id: txnId, action, correct_voucher_id: correctVoucherId }),
    })
    if (!res.ok) console.error('confirm error:', await res.text())
    setConfirming(null); setSelected(null); load()
  }

  const rerunMatch = async () => {
    setRerunning(true); setRerunError(null)
    try {
      const { data: { session } } = await supabase.auth.refreshSession()
      const res = await fetch('/api/bank-recon-match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({ statement_id: statementId, company_id: companyId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setRerunError((body as { error?: string }).error ?? `Server error ${res.status}`)
      }
    } catch (e) {
      setRerunError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setRerunning(false)
      load()
    }
  }

  if (loading) return <div className={css.loading}><Loader size={16} className={css.spin} /> Loading…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div className={css.filterBar}>
        {([
          ['all',            'All',           txns.length],
          ['auto_matched',   'Auto-matched',  counts.auto_matched   ?? 0],
          ['pending_review', 'Needs review',  counts.pending_review ?? 0],
          ['unmatched',      'Unmatched',     counts.unmatched      ?? 0],
          ['manual_matched', 'Confirmed',     counts.manual_matched ?? 0],
          ['disputed',       'Disputed',      counts.disputed       ?? 0],
          ['written_off',    'Written off',   counts.written_off    ?? 0],
        ] as [MFilter, string, number][]).filter(([k, , c]) => k === 'all' || c > 0).map(([k, l, c]) => (
          <button key={k}
            className={`${css.filterPill} ${filter === k ? css.filterPillActive : ''}`}
            onClick={() => setFilter(k)}>
            {l}<span className={css.pillCount}>{c}</span>
          </button>
        ))}
        <button className={css.btnGhost} style={{ marginLeft: 'auto' }} onClick={load}>
          <RefreshCw size={13} /> Refresh
        </button>
        <button className={css.btnSecondary} style={{ fontSize: '0.75rem', padding: '0.25rem 0.625rem' }}
          disabled={rerunning} onClick={rerunMatch}>
          {rerunning ? <><Loader size={13} className={css.spin} /> Matching…</> : 'Re-run matching'}
        </button>
        {rerunError && (
          <span style={{ fontSize: '0.72rem', color: 'var(--color-danger, #e53e3e)', marginLeft: '0.25rem' }}>
            {rerunError}
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 340px' : '1fr', gap: '0.75rem', alignItems: 'start' }}>
        <div className={`${css.card} ${css.tableWrap}`}>
          <table className={css.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Narration</th>
                <th className={css.right}>Debit</th>
                <th className={css.right}>Credit</th>
                <th className={css.right}>Balance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(txn => (
                <tr key={txn.id}
                  className={`${css.tableRow} ${selected?.id === txn.id ? css.tableRowSelected : ''}`}
                  onClick={() => setSelected(selected?.id === txn.id ? null : txn)}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(txn.txn_date)}</td>
                  <td style={{ maxWidth: 260 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {txn.narration}
                    </div>
                    {txn.counterparty && (
                      <div className={css.mutedText}>{txn.counterparty}</div>
                    )}
                  </td>
                  <td className={`${css.debitAmt}  ${css.right}`}>{txn.debit  != null ? fmt(txn.debit)  : ''}</td>
                  <td className={`${css.creditAmt} ${css.right}`}>{txn.credit != null ? fmt(txn.credit) : ''}</td>
                  <td className={`${css.monoAmt}   ${css.right}`}>{fmt(txn.balance)}</td>
                  <td><StatusChip status={txn.match_status} /></td>
                </tr>
              ))}
              {!visible.length && (
                <tr>
                  <td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-dim)' }}>
                    No transactions
                  </td>
                </tr>
              )}
              {txns.length >= 1000 && (
                <tr>
                  <td colSpan={6} style={{ padding: '0.5rem 0.75rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.8125rem', borderTop: '1px solid var(--border)' }}>
                    Showing first 1,000 transactions
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Detail panel */}
        {selected && (
          <div className={css.card} style={{ position: 'sticky', top: '1rem' }}>
            <div className={css.cardHeader}>
              <span className={css.cardLabel}>Transaction detail</span>
              <button className={css.btnGhost} onClick={() => setSelected(null)}><X size={14} /></button>
            </div>
            <div className={css.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>

              {/* Bank transaction */}
              <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{fmtDate(selected.txn_date)}</div>
              <div style={{ fontSize: '0.875rem', wordBreak: 'break-all' }}>{selected.narration}</div>
              {selected.reference && <div className={css.mutedText}>Ref: {selected.reference}</div>}
              <div style={{ display: 'flex', gap: '1rem', marginTop: '0.25rem' }}>
                {selected.debit  != null && <span style={{ color: 'var(--error)',  fontFamily: 'var(--font-mono)' }}>−{fmt(selected.debit)}</span>}
                {selected.credit != null && <span style={{ color: 'var(--teal)', fontFamily: 'var(--font-mono)' }}>+{fmt(selected.credit)}</span>}
              </div>

              {/* Proposed voucher card */}
              {(() => {
                const match = Array.isArray(selected.recon_matches) ? selected.recon_matches[0] ?? null : selected.recon_matches
                if (!match) return null
                return (
                  <div style={{ marginTop: '0.5rem', padding: '0.625rem 0.75rem', background: 'var(--surface-2)', borderRadius: 'var(--radius)', fontSize: '0.8125rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600 }}>Proposed match — {match.match_confidence?.toFixed(0)}% confidence</span>
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', background: 'var(--surface-3)', padding: '1px 6px', borderRadius: 4 }}>
                        {MATCH_METHOD_LABELS[match.match_method] ?? match.match_method}
                      </span>
                    </div>
                    {voucherLoading
                      ? <div style={{ color: 'var(--text-dim)' }}><Loader size={12} className={css.spin} /> Loading voucher…</div>
                      : voucherDetail
                        ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <strong style={{ color: 'var(--teal)' }}>{voucherDetail.voucher_number}</strong>
                              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(voucherDetail.amount)}</span>
                            </div>
                            <div style={{ color: 'var(--text-muted)' }}>{fmtDate(voucherDetail.voucher_date)}{voucherDetail.party ? ` · ${voucherDetail.party}` : ''}</div>
                            {voucherDetail.narration && <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{voucherDetail.narration}</div>}
                          </div>
                        )
                        : <div style={{ color: 'var(--text-dim)' }}>{match.match_reason}</div>
                    }
                  </div>
                )
              })()}

              {/* Action buttons for pending_review */}
              {selected.match_status === 'pending_review' && (
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                  <button className={css.btnPrimary} disabled={confirming === selected.id}
                    onClick={() => doAction(selected.id, 'confirm')}>
                    {confirming === selected.id ? <Loader size={13} className={css.spin} /> : <Check size={13} />}
                    {' '}Confirm match
                  </button>
                  <button className={css.btnSecondary} disabled={confirming === selected.id}
                    onClick={() => doAction(selected.id, 'reject')}>
                    <X size={13} /> Reject
                  </button>
                </div>
              )}

              {/* Un-match for auto_matched */}
              {selected.match_status === 'auto_matched' && (
                <button className={css.btnSecondary} disabled={confirming === selected.id}
                  onClick={() => doAction(selected.id, 'reject')}
                  style={{ marginTop: '0.25rem' }}>
                  <X size={13} /> Un-match
                </button>
              )}

              {/* ── Match to a different voucher ───────────────────────── */}
              {(selected.match_status === 'pending_review' || selected.match_status === 'unmatched' || selected.match_status === 'auto_matched') && (
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.625rem', marginTop: '0.25rem' }}>
                  <button className={css.btnGhost} style={{ fontSize: '0.8rem', padding: '2px 0' }}
                    onClick={() => { setShowPicker(p => !p); setPickedVoucher(null); setVoucherSearch('') }}>
                    {showPicker ? '▲' : '▼'} Match to a different voucher
                  </button>

                  {showPicker && (
                    <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                      <input
                        className={css.input}
                        style={{ fontSize: '0.8125rem', padding: '0.3rem 0.5rem' }}
                        placeholder="Type voucher number (e.g. VCH-2026-27-00123)"
                        value={voucherSearch}
                        onChange={e => { setVoucherSearch(e.target.value); setPickedVoucher(null) }}
                        autoFocus
                      />
                      {searching && <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}><Loader size={11} className={css.spin} /> Searching…</div>}
                      {searchResults.map(v => (
                        <div key={v.id}
                          onClick={() => { setPickedVoucher(v); setVoucherSearch(v.voucher_number) }}
                          style={{
                            padding: '0.375rem 0.5rem', borderRadius: 'var(--radius)',
                            background: pickedVoucher?.id === v.id ? 'var(--teal-dim)' : 'var(--surface-2)',
                            border: pickedVoucher?.id === v.id ? '1px solid var(--teal)' : '1px solid transparent',
                            cursor: 'pointer', fontSize: '0.8125rem',
                          }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <strong>{v.voucher_number}</strong>
                            <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(v.amount)}</span>
                          </div>
                          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                            {fmtDate(v.voucher_date)}{v.party ? ` · ${v.party}` : ''}
                          </div>
                        </div>
                      ))}
                      {pickedVoucher && (
                        <button className={css.btnPrimary} disabled={confirming === selected.id}
                          onClick={() => doAction(selected.id, 'reject', pickedVoucher.id)}>
                          {confirming === selected.id ? <Loader size={13} className={css.spin} /> : <Check size={13} />}
                          {' '}Link to {pickedVoucher.voucher_number}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Mark as excluded (bank charges, fees, etc.) ────────── */}
              {(selected.match_status === 'unmatched' || selected.match_status === 'pending_review') && (
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.625rem', marginTop: '0.25rem' }}>
                  <button className={css.btnGhost}
                    style={{ fontSize: '0.8rem', color: 'var(--text-dim)', padding: '2px 0' }}
                    disabled={confirming === selected.id}
                    onClick={() => doAction(selected.id, 'write_off')}>
                    Mark as excluded (bank charge / no voucher)
                  </button>
                </div>
              )}

            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Queries Tab ───────────────────────────────────────────────────────────────
// Shows all open recon_queries across all statements for this company.
// The old thread/message model is NOT ported — recon_queries uses resolution_note only.

function QueriesTab({ companyId }: { companyId: string }) {
  const [queries, setQueries] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const [resolving, setResolving] = useState<string | null>(null)
  const [note, setNote]           = useState<Record<string, string>>({})

  const load = useCallback(() => {
    setLoading(true)
    supabase.schema('pramaana').from('recon_queries')
      .select('id, query_type, status, resolution_note, created_at, recon_transactions(txn_date, narration, debit, credit)')
      .eq('company_id', companyId)
      .in('status', ['open', 'investigating'])
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => { setQueries((data ?? []) as Record<string, unknown>[]); setLoading(false) })
  }, [companyId])

  useEffect(() => { load() }, [load])

  const resolve = async (id: string) => {
    setResolving(id)
    const { data: { session } } = await supabase.auth.refreshSession()
    await fetch(`/api/bank-recon-queries?id=${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify({ status: 'resolved', resolution_note: note[id] ?? '' }),
    })
    setResolving(null)
    load()
  }

  const STATUS_CSS: Record<string, string> = {
    open: css.chipUnbooked, investigating: css.chipFuzzy,
    resolved: css.chipMatched, written_off: css.chipIgnored, adjusted: css.chipConfirmed,
  }

  if (loading) return <div className={css.loading}><Loader size={16} className={css.spin} /> Loading…</div>
  if (!queries.length) return (
    <div className={css.emptyState}>
      <CheckCircle size={24} style={{ marginBottom: '0.5rem', color: 'var(--success)' }} />
      <p>No open queries. All reconciling items are resolved.</p>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div className={`${css.card} ${css.tableWrap}`}>
        <table className={css.table}>
          <thead>
            <tr>
              <th>Type</th><th>Date</th><th>Narration</th>
              <th className={css.right}>Amount</th><th>Status</th><th>Resolve</th>
            </tr>
          </thead>
          <tbody>
            {queries.map(q => {
              const txn = q.recon_transactions as Record<string, unknown> | null
              return (
                <tr key={q.id as string} className={css.tableRow}>
                  <td style={{ whiteSpace: 'nowrap', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-dim)' }}>
                    {(q.query_type as string).replace(/_/g, ' ')}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {txn?.txn_date ? fmtDate(txn.txn_date as string) : '—'}
                  </td>
                  <td style={{ maxWidth: 240 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {(txn?.narration as string) ?? '—'}
                    </div>
                  </td>
                  <td className={`${css.monoAmt} ${css.right}`}>
                    {txn?.debit  ? <span style={{ color: 'var(--error)' }}>{fmt(txn.debit  as number)}</span> : null}
                    {txn?.credit ? <span style={{ color: 'var(--teal)' }}>{fmt(txn.credit as number)}</span> : null}
                  </td>
                  <td>
                    <span className={`${css.chip} ${STATUS_CSS[q.status as string] ?? css.chipUnmatched}`}>
                      {(q.status as string).replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td onClick={e => e.stopPropagation()} style={{ minWidth: 200 }}>
                    <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                      <input className={css.input}
                        style={{ flex: 1, fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                        placeholder="Resolution note…"
                        value={note[q.id as string] ?? ''}
                        onChange={e => setNote(prev => ({ ...prev, [q.id as string]: e.target.value }))} />
                      <button className={css.btnGhost} disabled={resolving === q.id as string}
                        onClick={() => resolve(q.id as string)}>
                        {resolving === q.id as string
                          ? <Loader size={13} className={css.spin} />
                          : <><Check size={13} /> Resolve</>}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── BRS Tab ───────────────────────────────────────────────────────────────────
// Reads bank list from recon_bank_accounts (auto-provisioned on first upload),
// not the old bank_format_config table.

function BrsTab({ companyId }: { companyId: string }) {
  const [accounts, setAccounts] = useState<{ id: string; bank_name: string; bank_code: string; account_number: string }[]>([])
  const [accountId, setAccountId] = useState('')
  const [asAt, setAsAt]           = useState(new Date().toISOString().slice(0, 10))
  const [result, setResult]       = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState<string | null>(null)

  useEffect(() => {
    supabase.schema('pramaana').from('recon_bank_accounts')
      .select('id, bank_name, bank_code, account_number')
      .eq('company_id', companyId).eq('is_active', true)
      .then(({ data }) => setAccounts((data ?? []) as typeof accounts))
  }, [companyId])

  const runBrs = async () => {
    setLoading(true); setError(null)
    const { data: { session } } = await supabase.auth.refreshSession()
    const res = await fetch(
      `/api/bank-recon-brs?company_id=${companyId}&bank_account_id=${accountId}&as_at_date=${asAt}`,
      { headers: { Authorization: `Bearer ${session?.access_token ?? ''}` } }
    )
    const json = await res.json() as Record<string, unknown>
    if (!res.ok) { setError((json.error as string) ?? 'BRS failed'); setLoading(false); return }
    setResult(json); setLoading(false)
  }

  type BrsItem = { date: string; narration: string; amount: number }
  const BrsLine = ({ label, items }: { label: string; items: BrsItem[] }) => {
    if (!items?.length) return null
    return (
      <>
        <div className={css.brsRow}><span className={css.brsLabel} style={{ fontWeight: 600 }}>{label}</span></div>
        {items.map((item, i) => (
          <div key={i} className={css.brsRow} style={{ paddingLeft: '1rem' }}>
            <span className={css.brsLabel}>{fmtDate(item.date)} · {item.narration}</span>
            <span className={css.brsValue}>{fmt(item.amount)}</span>
          </div>
        ))}
      </>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 640 }}>
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className={css.field} style={{ flex: 1, minWidth: 200 }}>
          <label className={css.label}>Bank account</label>
          <select className={css.select} value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">— Select account —</option>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.bank_name} ···{a.account_number.slice(-4)}
              </option>
            ))}
          </select>
        </div>
        {!accounts.length && (
          <div style={{ fontSize: '0.8125rem', color: 'var(--text-dim)', alignSelf: 'flex-end', paddingBottom: '0.25rem' }}>
            Upload a statement first — bank accounts are provisioned automatically.
          </div>
        )}
        <div className={css.field}>
          <label className={css.label}>As at date</label>
          <input type="date" className={css.input} value={asAt}
            onChange={e => setAsAt(e.target.value)} />
        </div>
        <button className={css.btnPrimary} disabled={!accountId || !asAt || loading} onClick={runBrs}>
          {loading ? <Loader size={14} className={css.spin} /> : <BarChart2 size={14} />}
          {' '}Generate BRS
        </button>
      </div>

      {error && (
        <div className={css.validationFail}><AlertCircle size={15} />{error}</div>
      )}

      {result && (
        <div className={css.card}>
          <div className={css.cardHeader}>
            <span className={css.cardLabel}>Bank Reconciliation Statement — {fmtDate(asAt)}</span>
            <button className={css.btnGhost} onClick={() => window.print()}>Print</button>
          </div>
          <div className={css.cardBody}>
            <div className={css.brsTable}>
              <div className={css.brsRow}>
                <span className={css.brsLabel}>Balance as per Bank Statement</span>
                <span className={css.brsValue}>{fmt(result.balance_per_bank as number)}</span>
              </div>
              <BrsLine label="Add: Deposits not yet cleared"
                items={result.cheques_deposited_not_cleared as BrsItem[]} />
              <BrsLine label="Less: Cheques not yet presented"
                items={result.cheques_issued_not_presented as BrsItem[]} />
              <BrsLine label="Add: Bank credits not in books"
                items={result.bank_credits_not_in_books as BrsItem[]} />
              <BrsLine label="Less: Bank debits/charges not in books"
                items={result.bank_debits_not_in_books as BrsItem[]} />
              <div className={css.brsRowTotal}>
                <span className={css.brsLabel}>Adjusted Bank Balance</span>
                <span className={css.brsValue}>{fmt(result.adjusted_bank_balance as number)}</span>
              </div>
              <div className={css.brsRow}>
                <span className={css.brsLabel}>Balance as per Books</span>
                <span className={css.brsValue}>{fmt(result.balance_per_books as number)}</span>
              </div>
              <div className={css.brsRowTotal}>
                <span className={css.brsLabel} style={{ fontWeight: 700 }}>
                  Difference {Math.abs((result.difference as number) ?? 1) < 0.01 ? '✓ Nil' : ''}
                </span>
                <span className={
                  Math.abs((result.difference as number) ?? 1) < 0.01
                    ? css.brsVariance : css.brsVarianceBad
                }>
                  {fmt(result.difference as number)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'upload' | 'statements' | 'workbench' | 'queries' | 'brs'

export default function BankReconPage() {
  const { user }  = useAuth()
  const params    = useParams<{ statementId?: string }>()
  const navigate  = useNavigate()

  const companyId = user?.activeCompany?.id ?? ''
  const [tab, setTab]     = useState<Tab>(params.statementId ? 'workbench' : 'upload')
  const [stmtId, setStmtId] = useState<string | null>(params.statementId ?? null)

  if (!companyId) {
    return (
      <div className={css.page}>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>No active company selected.</p>
      </div>
    )
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: 'upload',     label: 'Upload' },
    { key: 'statements', label: 'Statements' },
    ...(stmtId ? [{ key: 'workbench' as Tab, label: 'Match Workbench' }] : []),
    { key: 'queries',    label: 'Queries' },
    { key: 'brs',        label: 'BRS Report' },
  ]

  return (
    <div className={css.page}>
      <div className={css.pageHeader}>
        <div className={css.pageTitleBlock}>
          <h1 className={css.pageTitle}>Bank Reconciliation</h1>
          <p className={css.pageSubtitle}>
            {user?.activeCompany?.name ?? ''} · Upload, match &amp; query bank statements
          </p>
        </div>
      </div>

      {/* overflowX:auto makes the tab bar horizontally scrollable on mobile */}
      <div className={css.tabBar} style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {TABS.map(t => (
          <button key={t.key}
            className={`${css.tab} ${tab === t.key ? css.tabActive : ''}`}
            style={{ flexShrink: 0 }}
            onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'upload' && (
        <UploadTab companyId={companyId} onComplete={id => {
          setStmtId(id); setTab('workbench'); navigate(`/bank-recon/${id}`)
        }} />
      )}
      {tab === 'statements' && (
        <StatementsTab companyId={companyId} onSelect={id => {
          setStmtId(id); setTab('workbench'); navigate(`/bank-recon/${id}`)
        }} />
      )}
      {tab === 'workbench' && stmtId && (
        <WorkbenchTab statementId={stmtId} companyId={companyId} />
      )}
      {tab === 'workbench' && !stmtId && (
        <div className={css.emptyState}>Select a statement from the Statements tab first.</div>
      )}
      {tab === 'queries' && <QueriesTab companyId={companyId} />}
      {tab === 'brs'     && <BrsTab companyId={companyId} />}
    </div>
  )
}
