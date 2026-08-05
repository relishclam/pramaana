// Run with: node scripts/write-bank-recon-page.mjs
import { writeFileSync } from 'fs'

const content = `// ── Autonomous Bank Reconciliation Page ─────────────────────────────────────
// No bank selector. No date pickers. Everything auto-detected from the file.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Upload, CheckCircle, AlertCircle, RefreshCw, X, FileText, BarChart2, Loader, Check, Trash2 } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import css from './BankRecon.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface UploadSummary {
  bank: { code: string; name: string; confidence: number }
  account_number: string | null
  period_from: string; period_to: string
  txn_count: number; debit_count: number; credit_count: number
  total_debits: number; total_credits: number
  opening_balance: number; closing_balance: number
}
interface MatchResult { exact_matches: number; fuzzy_matches: number; ai_matches: number; unmatched: number; queries_created: number }
interface OverlapInfo { existing_statement_id: string; existing_period_from: string; existing_period_to: string; overlap_from: string; overlap_to: string; duplicate_txn_count: number }
interface Discontinuity { row: number; expected: number; actual: number }
interface ValidationResult { is_valid: boolean; opening_balance: number; closing_balance: number; computed_closing: number; total_debits: number; total_credits: number; balance_continuous: boolean; discontinuities: Discontinuity[]; errors: string[] }
interface ReconStatement { id: string; period_from: string; period_to: string; opening_balance: number; closing_balance: number; txn_count: number; upload_status: string; file_name: string | null; created_at: string; recon_bank_accounts: { bank_code: string; bank_name: string; account_number: string } | null }
interface ReconTransaction { id: string; row_number: number; txn_date: string; narration: string; reference: string | null; debit: number | null; credit: number | null; balance: number; txn_type: string | null; counterparty: string | null; match_status: string; recon_matches: { match_method: string; match_confidence: number; match_reason: string; is_confirmed: boolean; voucher_id: string | null } | null }

// ── Helpers ───────────────────────────────────────────────────────────────────

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
const fmt = (n: number | null | undefined) => n == null ? '—' : inr.format(n)
const fmtDate = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { const r = reader.result as string; resolve(r.split(',')[1] ?? r) }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
const MATCH_LABELS: Record<string, string> = { unmatched: 'Unmatched', pending_review: 'Needs review', auto_matched: 'Auto-matched', manual_matched: 'Confirmed', disputed: 'Disputed', written_off: 'Written off' }
const MATCH_CSS: Record<string, string> = { unmatched: css.chipUnmatched, pending_review: css.chipFuzzy, auto_matched: css.chipMatched, manual_matched: css.chipConfirmed, disputed: css.chipQueried, written_off: css.chipIgnored }

// ── Upload Tab ────────────────────────────────────────────────────────────────

type Phase = 'idle'|'uploading'|'detecting'|'parsing'|'validating'|'matching'|'done'|'needs_bank'|'overlap'|'warn_validation'|'error'
const STEPS: Phase[] = ['uploading','detecting','parsing','validating','matching','done']
const STEP_LABELS: Record<string, string> = { uploading:'Uploading', detecting:'Detecting bank', parsing:'Parsing', validating:'Validating', matching:'Matching', done:'Done' }

function UploadTab({ companyId, onComplete }: { companyId: string; onComplete: (id: string) => void }) {
  const [drag, setDrag]           = useState(false)
  const [phase, setPhase]         = useState<Phase>('idle')
  const [error, setError]         = useState<string | null>(null)
  const [summary, setSummary]     = useState<UploadSummary | null>(null)
  const [matchResult, setMatch]   = useState<MatchResult | null>(null)
  const [overlap, setOverlap]     = useState<OverlapInfo | null>(null)
  const [validation, setValid]    = useState<ValidationResult | null>(null)
  const [storagePath, setStorage] = useState<string | null>(null)
  const [candidates, setCands]    = useState<{ code: string; name: string; confidence: number }[]>([])
  const [selBank, setSelBank]     = useState('')
  const [pending, setPending]     = useState<File | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setPhase('idle'); setError(null); setSummary(null); setMatch(null)
    setOverlap(null); setValid(null); setStorage(null)
    setCands([]); setSelBank(''); setPending(null)
  }

  const runUpload = useCallback(async (file: File, opts: { bankCode?: string; overlapResolution?: string; storagePath?: string } = {}) => {
    setError(null); setPhase('uploading')
    let b64: string
    try { b64 = await toBase64(file) } catch { setError('Failed to read file.'); setPhase('error'); return }
    setPhase('detecting')
    const body: Record<string, unknown> = { company_id: companyId, file_base64: b64, file_name: file.name, file_type: file.type || file.name.split('.').pop() || 'text/csv' }
    if (opts.bankCode)          body.bank_code          = opts.bankCode
    if (opts.overlapResolution) body.overlap_resolution = opts.overlapResolution
    if (opts.storagePath)       body.storage_path       = opts.storagePath
    setPhase('parsing')
    let json: Record<string, unknown>
    try {
      const res = await fetch('/api/bank-recon-upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      json = await res.json()
    } catch { setError('Network error.'); setPhase('error'); return }
    const s = json.status as string
    if (s === 'error')                { setError((json.error as string) ?? 'Upload failed.'); setPhase('error'); return }
    if (s === 'needs_bank_selection') { setCands((json.bank_candidates as typeof candidates) ?? []); setPending(file); setPhase('needs_bank'); return }
    if (s === 'overlap_detected')     { setOverlap(json.overlap as OverlapInfo); setStorage((json.storage_path as string) ?? null); setPending(file); setPhase('overlap'); return }
    if (s === 'validation_warning')   { setValid(json.validation as ValidationResult); setStorage((json.storage_path as string) ?? null); setPending(file); setPhase('warn_validation'); return }
    setPhase('matching')
    setSummary(json.summary as UploadSummary)
    setMatch((json.match_result as MatchResult) ?? null)
    setPhase('done')
    if (json.statement_id) onComplete(json.statement_id as string)
  }, [companyId, onComplete])

  const handleDrop  = (e: React.DragEvent) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) { reset(); runUpload(f) } }
  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) { reset(); runUpload(f) }; if (inputRef.current) inputRef.current.value = '' }
  const inProg = ['uploading','detecting','parsing','validating','matching'].includes(phase)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 680 }}>
      {phase === 'idle' && (
        <div className={\`\${css.dropZone} \${drag ? css.dropZoneActive : ''}\`}
          onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
          onDrop={handleDrop} onClick={() => inputRef.current?.click()}>
          <Upload size={28} className={css.dropZoneIcon} />
          <p className={css.dropZoneText}>Drop CSV or XLSX here, or click to browse</p>
          <p className={css.dropZoneHint}>Bank, period and format are detected automatically — no manual input needed</p>
          <input ref={inputRef} type="file" hidden accept=".csv,.xlsx,.xls,.tsv" onChange={handleInput} />
        </div>
      )}
      {inProg && (
        <div className={css.card}>
          <div className={css.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {STEPS.map(step => {
              const idx = STEPS.indexOf(step); const curr = STEPS.indexOf(phase as Phase)
              const done = idx < curr; const active = idx === curr
              return (
                <div key={step} className={css.progressRow}>
                  {done   && <CheckCircle size={15} className={css.progressStepDone} />}
                  {active && <Loader size={15} className={\`\${css.progressStepActive} \${css.spin}\`} />}
                  {!done && !active && <div style={{ width:15, height:15, borderRadius:'50%', border:'1.5px solid var(--border-2)', flexShrink:0 }} />}
                  <span className={done?css.progressStepDone:active?css.progressStepActive:css.progressStep}>{STEP_LABELS[step]}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {phase === 'error' && (
        <div className={css.validationFail}>
          <AlertCircle size={15} style={{ flexShrink:0, marginTop:2 }} />
          <div style={{ flex:1 }}><div style={{ fontWeight:600, marginBottom:4 }}>Upload failed</div><div>{error}</div></div>
          <button className={css.btnGhost} onClick={reset}>Try again</button>
        </div>
      )}
      {phase === 'needs_bank' && (
        <div className={css.card}>
          <div className={css.cardHeader}><span className={css.cardLabel}>Bank not detected — please select</span></div>
          <div className={css.cardBody} style={{ display:'flex', flexDirection:'column', gap:'0.75rem' }}>
            <p style={{ fontSize:'0.875rem', color:'var(--text-muted)', margin:0 }}>Could not identify the bank. Select and retry.</p>
            <select className={css.select} value={selBank} onChange={e => setSelBank(e.target.value)}>
              <option value="">— Select bank —</option>
              {(candidates.length ? candidates : [{code:'HDFC',name:'HDFC Bank'},{code:'CANARA',name:'Canara Bank'},{code:'FEDERAL',name:'Federal Bank'},{code:'SIB',name:'South Indian Bank'},{code:'ICICI',name:'ICICI Bank'}] as {code:string;name:string}[]).map(b => (
                <option key={b.code} value={b.code}>{b.name}</option>
              ))}
            </select>
            <div style={{ display:'flex', gap:'0.5rem' }}>
              <button className={css.btnPrimary} disabled={!selBank||!pending} onClick={() => pending && runUpload(pending, { bankCode: selBank })}>Parse with selected bank</button>
              <button className={css.btnSecondary} onClick={reset}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {phase === 'overlap' && overlap && (
        <div className={css.card}>
          <div className={css.cardHeader}><span className={css.cardLabel} style={{ color:'var(--gold)' }}>⚠ Overlapping period detected</span></div>
          <div className={css.cardBody} style={{ display:'flex', flexDirection:'column', gap:'1rem' }}>
            <p style={{ fontSize:'0.875rem', color:'var(--text-muted)', margin:0 }}>
              Existing statement covers <strong>{fmtDate(overlap.overlap_from)} – {fmtDate(overlap.overlap_to)}</strong>.
              {overlap.duplicate_txn_count > 0 && \` \${overlap.duplicate_txn_count} transactions overlap.\`}
            </p>
            <div style={{ display:'flex', gap:'0.5rem', flexWrap:'wrap' }}>
              <button className={css.btnPrimary}   onClick={() => pending && runUpload(pending, { overlapResolution:'skip_duplicates', storagePath: storagePath ?? undefined })}>Skip duplicates</button>
              <button className={css.btnSecondary} onClick={() => pending && runUpload(pending, { overlapResolution:'replace',         storagePath: storagePath ?? undefined })}>Replace existing</button>
              <button className={css.btnSecondary} onClick={() => pending && runUpload(pending, { overlapResolution:'merge',           storagePath: storagePath ?? undefined })}>Merge</button>
              <button className={css.btnGhost} onClick={reset}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {phase === 'warn_validation' && validation && (
        <div className={css.card}>
          <div className={css.cardHeader}><span className={css.cardLabel} style={{ color:'var(--gold)' }}>⚠ Balance discontinuities detected</span></div>
          <div className={css.cardBody} style={{ display:'flex', flexDirection:'column', gap:'0.75rem' }}>
            <p style={{ fontSize:'0.875rem', color:'var(--text-muted)', margin:0 }}>
              {validation.discontinuities.length} balance check{validation.discontinuities.length!==1?'s':''} failed.
              Computed: {fmt(validation.computed_closing)} vs statement: {fmt(validation.closing_balance)}.
            </p>
            {validation.discontinuities.slice(0,5).map(d => (
              <div key={d.row} style={{ fontSize:'0.8125rem', color:'var(--text-dim)', paddingLeft:'0.75rem' }}>Row {d.row}: expected {fmt(d.expected)}, got {fmt(d.actual)}</div>
            ))}
            {validation.discontinuities.length > 5 && <div style={{ fontSize:'0.8125rem', color:'var(--text-dim)', paddingLeft:'0.75rem' }}>…and {validation.discontinuities.length-5} more</div>}
            <div style={{ display:'flex', gap:'0.5rem' }}>
              <button className={css.btnPrimary}   onClick={() => pending && runUpload(pending, { storagePath: storagePath ?? undefined })}>Proceed anyway</button>
              <button className={css.btnSecondary} onClick={reset}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {phase === 'done' && summary && (
        <div style={{ display:'flex', flexDirection:'column', gap:'0.75rem' }}>
          <div style={{ display:'flex', alignItems:'center', gap:'0.75rem', padding:'0.625rem 0.875rem', background:'rgba(74,158,158,0.08)', border:'1px solid rgba(74,158,158,0.25)', borderRadius:'var(--radius)', fontSize:'0.875rem' }}>
            <CheckCircle size={15} style={{ color:'var(--teal)', flexShrink:0 }} />
            <span style={{ color:'var(--text)' }}>
              <strong>{summary.bank.name}</strong> · {fmtDate(summary.period_from)} – {fmtDate(summary.period_to)}
              {summary.account_number && <span style={{ color:'var(--text-muted)' }}> · ···{summary.account_number.slice(-4)}</span>}
            </span>
            <span style={{ marginLeft:'auto', fontSize:'0.75rem', color:'var(--text-dim)' }}>{summary.bank.confidence}% confidence</span>
          </div>
          <div className={css.card}>
            <div className={css.statGrid}>
              <div className={css.stat}><div className={css.statLabel}>Transactions</div><div className={css.statValue}>{summary.txn_count}</div></div>
              <div className={css.stat}><div className={css.statLabel}>Opening</div><div className={css.statValue} style={{ fontSize:'1rem' }}>{fmt(summary.opening_balance)}</div></div>
              <div className={css.stat}><div className={css.statLabel}>Closing</div><div className={css.statValue} style={{ fontSize:'1rem' }}>{fmt(summary.closing_balance)}</div></div>
              <div className={css.stat}><div className={css.statLabel}>Net</div>
                <div className={\`\${css.statValue} \${(summary.closing_balance-summary.opening_balance)>=0?css.statValueTeal:css.statValueError}\`} style={{ fontSize:'1rem' }}>
                  {fmt(summary.closing_balance-summary.opening_balance)}
                </div>
              </div>
            </div>
          </div>
          {matchResult && (
            <div className={css.card}>
              <div className={css.cardHeader}><span className={css.cardLabel}>Match results</span></div>
              <div className={css.statGrid}>
                <div className={css.stat}><div className={css.statLabel}>Auto-matched</div><div className={\`\${css.statValue} \${css.statValueSuccess}\`}>{matchResult.exact_matches}</div></div>
                <div className={css.stat}><div className={css.statLabel}>Needs review</div><div className={\`\${css.statValue} \${css.statValueAmber}\`}>{matchResult.fuzzy_matches+matchResult.ai_matches}</div></div>
                <div className={css.stat}><div className={css.statLabel}>Unmatched</div><div className={\`\${css.statValue} \${matchResult.unmatched>0?css.statValueError:css.statValueSuccess}\`}>{matchResult.unmatched}</div></div>
                <div className={css.stat}><div className={css.statLabel}>Queries</div><div className={css.statValue}>{matchResult.queries_created}</div></div>
              </div>
            </div>
          )}
          <button className={css.btnSecondary} onClick={reset} style={{ alignSelf:'flex-start' }}>Upload another statement</button>
        </div>
      )}
    </div>
  )
}

// ── Statements Tab ────────────────────────────────────────────────────────────

function StatementsTab({ companyId, onSelect }: { companyId: string; onSelect: (id: string) => void }) {
  const [stmts, setStmts]       = useState<ReconStatement[]>([])
  const [loading, setLoading]   = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    supabase.schema('pramaana').from('recon_statements')
      .select('id, period_from, period_to, opening_balance, closing_balance, txn_count, upload_status, file_name, created_at, recon_bank_accounts(bank_code, bank_name, account_number)')
      .eq('company_id', companyId).order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => { setStmts((data??[]) as unknown as ReconStatement[]); setLoading(false) })
  }, [companyId])

  useEffect(() => { load() }, [load])

  const del = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Delete this statement and ALL its transactions, matches and queries? This cannot be undone.')) return
    setDeleting(id)
    await fetch(\`/api/bank-recon-statements?id=\${id}\`, { method: 'DELETE' })
    setDeleting(null); load()
  }

  const SC: Record<string,string> = { matched:css.chipMatched, parsed:css.chipConfirmed, processing:css.chipFuzzy, pending_overlap:css.chipQueried, error:css.chipUnbooked }

  if (loading) return <div className={css.loading}><Loader size={16} className={css.spin}/> Loading…</div>
  if (!stmts.length) return <div className={css.emptyState}><FileText size={24} style={{ marginBottom:'0.5rem' }}/><p>No statements uploaded yet.</p></div>

  return (
    <div className={css.card}>
      <div className={css.stmtList}>
        {stmts.map(s => {
          const ba = s.recon_bank_accounts
          return (
            <div key={s.id} className={css.stmtRow} onClick={() => onSelect(s.id)}>
              <span className={css.stmtBank}>{ba?.bank_code ?? '—'}</span>
              <span className={css.stmtPeriod}>
                {fmtDate(s.period_from)} – {fmtDate(s.period_to)}
                {ba?.account_number && <span style={{ color:'var(--text-dim)', marginLeft:'0.5rem', fontSize:'0.75rem' }}>···{ba.account_number.slice(-4)}</span>}
              </span>
              <span className={css.stmtLines}>{s.txn_count} txns</span>
              <span className={css.stmtLines}>{fmt(s.closing_balance)}</span>
              <span className={\`\${css.chip} \${SC[s.upload_status]??css.chipUnmatched}\`}>{s.upload_status.replace('_',' ')}</span>
              <button onClick={e => del(s.id, e)} disabled={deleting===s.id} title="Delete statement"
                style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-dim)', padding:'2px', borderRadius:4, display:'flex', alignItems:'center', flexShrink:0 }}
                onMouseEnter={e => (e.currentTarget.style.color='var(--error)')}
                onMouseLeave={e => (e.currentTarget.style.color='var(--text-dim)')}>
                {deleting===s.id ? <Loader size={13} className={css.spin}/> : <Trash2 size={13}/>}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Match Workbench Tab ───────────────────────────────────────────────────────

type MF = 'all'|'unmatched'|'pending_review'|'auto_matched'|'manual_matched'

function WorkbenchTab({ statementId, companyId }: { statementId: string; companyId: string }) {
  const [txns, setTxns]         = useState<ReconTransaction[]>([])
  const [loading, setLoading]   = useState(true)
  const [filter, setFilter]     = useState<MF>('all')
  const [sel, setSel]           = useState<ReconTransaction | null>(null)
  const [confirming, setConf]   = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    supabase.schema('pramaana').from('recon_transactions')
      .select('id, row_number, txn_date, narration, reference, debit, credit, balance, txn_type, counterparty, match_status, recon_matches(match_method, match_confidence, match_reason, is_confirmed, voucher_id)')
      .eq('statement_id', statementId).order('row_number').limit(500)
      .then(({ data }) => { setTxns((data??[]) as unknown as ReconTransaction[]); setLoading(false) })
  }, [statementId])

  useEffect(() => { load() }, [load])

  const counts = { unmatched:txns.filter(t=>t.match_status==='unmatched').length, pending_review:txns.filter(t=>t.match_status==='pending_review').length, auto_matched:txns.filter(t=>t.match_status==='auto_matched').length, manual_matched:txns.filter(t=>t.match_status==='manual_matched').length }
  const filtered = filter==='all' ? txns : txns.filter(t=>t.match_status===filter)

  const doConfirm = async (txn: ReconTransaction, action: 'confirm'|'reject') => {
    setConf(txn.id)
    await fetch('/api/bank-recon-confirm', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ bank_txn_id: txn.id, action }) })
    setConf(null); setSel(null); load()
  }

  const rerun = async () => {
    await fetch('/api/bank-recon-match', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ statement_id: statementId, company_id: companyId }) })
    load()
  }

  if (loading) return <div className={css.loading}><Loader size={16} className={css.spin}/> Loading transactions…</div>

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'0.75rem' }}>
      <div className={css.filterBar}>
        {([['all','All',txns.length],['auto_matched','Auto-matched',counts.auto_matched],['pending_review','Needs review',counts.pending_review],['unmatched','Unmatched',counts.unmatched],['manual_matched','Confirmed',counts.manual_matched]] as [MF,string,number][]).map(([k,l,c]) => (
          <button key={k} className={\`\${css.filterPill} \${filter===k?css.filterPillActive:''}\`} onClick={()=>setFilter(k)}>{l}<span className={css.pillCount}>{c}</span></button>
        ))}
        <button className={css.btnGhost} style={{ marginLeft:'auto' }} onClick={load}><RefreshCw size={13}/> Refresh</button>
        <button className={css.btnSecondary} style={{ fontSize:'0.75rem', padding:'0.25rem 0.625rem' }} onClick={rerun}><RefreshCw size={13}/> Re-run matching</button>
      </div>
      <div style={{ display:'grid', gridTemplateColumns: sel?'1fr 340px':'1fr', gap:'0.75rem', alignItems:'start' }}>
        <div className={\`\${css.card} \${css.tableWrap}\`}>
          <table className={css.table}>
            <thead><tr><th>Date</th><th>Narration</th><th className={css.right}>Debit</th><th className={css.right}>Credit</th><th className={css.right}>Balance</th><th>Status</th></tr></thead>
            <tbody>
              {filtered.map(txn => (
                <tr key={txn.id} className={\`\${css.tableRow} \${sel?.id===txn.id?css.tableRowSelected:''}\`} onClick={()=>setSel(sel?.id===txn.id?null:txn)}>
                  <td style={{ whiteSpace:'nowrap' }}>{fmtDate(txn.txn_date)}</td>
                  <td style={{ maxWidth:300 }}><div style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{txn.narration}</div>{txn.counterparty&&<div className={css.mutedText}>{txn.counterparty}</div>}</td>
                  <td className={\`\${css.debitAmt} \${css.right}\`}>{txn.debit!=null?fmt(txn.debit):''}</td>
                  <td className={\`\${css.creditAmt} \${css.right}\`}>{txn.credit!=null?fmt(txn.credit):''}</td>
                  <td className={\`\${css.monoAmt} \${css.right}\`}>{fmt(txn.balance)}</td>
                  <td><span className={\`\${css.chip} \${MATCH_CSS[txn.match_status]??css.chipUnmatched}\`}>{MATCH_LABELS[txn.match_status]??txn.match_status}</span></td>
                </tr>
              ))}
              {!filtered.length && <tr><td colSpan={6} style={{ padding:'2rem', textAlign:'center', color:'var(--text-dim)' }}>No transactions</td></tr>}
            </tbody>
          </table>
        </div>
        {sel && (
          <div className={css.card} style={{ position:'sticky', top:'1rem' }}>
            <div className={css.cardHeader}><span className={css.cardLabel}>Transaction detail</span><button className={css.btnGhost} onClick={()=>setSel(null)}><X size={14}/></button></div>
            <div className={css.cardBody} style={{ display:'flex', flexDirection:'column', gap:'0.625rem' }}>
              <div style={{ fontSize:'0.8125rem', color:'var(--text-muted)' }}>{fmtDate(sel.txn_date)}</div>
              <div style={{ fontSize:'0.875rem', color:'var(--text)' }}>{sel.narration}</div>
              {sel.reference && <div className={css.mutedText}>Ref: {sel.reference}</div>}
              <div style={{ display:'flex', gap:'1rem', marginTop:'0.25rem' }}>
                {sel.debit!=null  && <span style={{ color:'var(--error)', fontFamily:'var(--font-mono)' }}>−{fmt(sel.debit)}</span>}
                {sel.credit!=null && <span style={{ color:'var(--teal)',  fontFamily:'var(--font-mono)' }}>+{fmt(sel.credit)}</span>}
              </div>
              {sel.recon_matches && (
                <div style={{ marginTop:'0.5rem', padding:'0.625rem 0.75rem', background:'var(--surface-2)', borderRadius:'var(--radius)', fontSize:'0.8125rem' }}>
                  <div style={{ fontWeight:600, color:'var(--text)', marginBottom:4 }}>Suggested match — {sel.recon_matches.match_confidence?.toFixed(0)}% confidence</div>
                  <div style={{ color:'var(--text-muted)' }}>{sel.recon_matches.match_reason}</div>
                  <div style={{ marginTop:'0.375rem', fontSize:'0.75rem', color:'var(--text-dim)' }}>Method: {sel.recon_matches.match_method}</div>
                </div>
              )}
              {sel.match_status==='pending_review' && (
                <div style={{ display:'flex', gap:'0.5rem', marginTop:'0.25rem' }}>
                  <button className={css.btnPrimary}   disabled={confirming===sel.id} onClick={()=>doConfirm(sel,'confirm')}>{confirming===sel.id?<Loader size={13} className={css.spin}/>:<Check size={13}/>} Confirm</button>
                  <button className={css.btnSecondary} disabled={confirming===sel.id} onClick={()=>doConfirm(sel,'reject')}><X size={13}/> Reject</button>
                </div>
              )}
              {sel.match_status==='auto_matched' && (
                <button className={css.btnSecondary} disabled={confirming===sel.id} onClick={()=>doConfirm(sel,'reject')}><X size={13}/> Un-match</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Queries Tab ───────────────────────────────────────────────────────────────

function QueriesTab({ companyId }: { companyId: string }) {
  const [queries, setQ] = useState<Record<string,unknown>[]>([])
  const [loading, setL] = useState(true)
  useEffect(() => {
    supabase.schema('pramaana').from('recon_queries')
      .select('id, query_type, status, created_at, recon_transactions(txn_date, narration, debit, credit)')
      .eq('company_id', companyId).order('created_at', { ascending: false }).limit(100)
      .then(({ data }) => { setQ((data??[]) as Record<string,unknown>[]); setL(false) })
  }, [companyId])
  const SC: Record<string,string> = { open:css.chipUnbooked, investigating:css.chipFuzzy, resolved:css.chipMatched, written_off:css.chipIgnored, adjusted:css.chipConfirmed }
  if (loading) return <div className={css.loading}><Loader size={16} className={css.spin}/> Loading…</div>
  if (!queries.length) return <div className={css.emptyState}><CheckCircle size={24} style={{ marginBottom:'0.5rem', color:'var(--success)' }}/><p>No open queries.</p></div>
  return (
    <div className={\`\${css.card} \${css.tableWrap}\`}>
      <table className={css.table}>
        <thead><tr><th>Type</th><th>Date</th><th>Narration</th><th className={css.right}>Amount</th><th>Status</th></tr></thead>
        <tbody>
          {queries.map(q => {
            const t = q.recon_transactions as Record<string,unknown>|null
            return (
              <tr key={q.id as string} className={css.tableRow}>
                <td style={{ whiteSpace:'nowrap', fontSize:'0.75rem', textTransform:'uppercase', letterSpacing:'0.04em', color:'var(--text-dim)' }}>{(q.query_type as string).replace('_',' ')}</td>
                <td style={{ whiteSpace:'nowrap' }}>{t?.txn_date?fmtDate(t.txn_date as string):'—'}</td>
                <td style={{ maxWidth:300 }}><div style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t?.narration as string??'—'}</div></td>
                <td className={\`\${css.monoAmt} \${css.right}\`}>
                  {t?.debit  && <span style={{ color:'var(--error)' }}>{fmt(t.debit  as number)}</span>}
                  {t?.credit && <span style={{ color:'var(--teal)'  }}>{fmt(t.credit as number)}</span>}
                </td>
                <td><span className={\`\${css.chip} \${SC[q.status as string]??css.chipUnmatched}\`}>{(q.status as string).replace('_',' ')}</span></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── BRS Tab ───────────────────────────────────────────────────────────────────

function BrsTab({ companyId }: { companyId: string }) {
  const [accounts, setA] = useState<{ id:string; bank_name:string; account_number:string }[]>([])
  const [acctId,  setAI] = useState('')
  const [asAt,    setD]  = useState(new Date().toISOString().slice(0,10))
  const [result,  setR]  = useState<Record<string,unknown>|null>(null)
  const [loading, setL]  = useState(false)
  const [err,     setE]  = useState<string|null>(null)
  useEffect(() => {
    supabase.schema('pramaana').from('recon_bank_accounts').select('id, bank_name, account_number').eq('company_id', companyId).eq('is_active', true)
      .then(({ data }) => setA((data??[]) as { id:string; bank_name:string; account_number:string }[]))
  }, [companyId])
  const run = async () => {
    setL(true); setE(null)
    const res = await fetch(\`/api/bank-recon-brs?company_id=\${companyId}&bank_account_id=\${acctId}&as_at_date=\${asAt}\`)
    const json = await res.json()
    if (!res.ok) { setE(json.error??'BRS failed'); setL(false); return }
    setR(json); setL(false)
  }
  type BI = { date:string; narration:string; amount:number }
  const Line = ({ label, items }: { label:string; items:BI[] }) => {
    if (!items?.length) return null
    return (<>
      <div className={css.brsRow}><span className={css.brsLabel} style={{ fontWeight:600 }}>{label}</span></div>
      {items.map((item,i) => <div key={i} className={css.brsRow} style={{ paddingLeft:'1rem' }}><span className={css.brsLabel}>{fmtDate(item.date)} · {item.narration}</span><span className={css.brsValue}>{fmt(item.amount)}</span></div>)}
    </>)
  }
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'1rem', maxWidth:640 }}>
      <div style={{ display:'flex', gap:'0.75rem', flexWrap:'wrap', alignItems:'flex-end' }}>
        <div className={css.field} style={{ flex:1, minWidth:200 }}>
          <label className={css.label}>Bank account</label>
          <select className={css.select} value={acctId} onChange={e=>setAI(e.target.value)}>
            <option value="">— Select account —</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.bank_name} ···{a.account_number.slice(-4)}</option>)}
          </select>
        </div>
        <div className={css.field}>
          <label className={css.label}>As at date</label>
          <input type="date" className={css.input} value={asAt} onChange={e=>setD(e.target.value)} />
        </div>
        <button className={css.btnPrimary} disabled={!acctId||!asAt||loading} onClick={run}>
          {loading?<Loader size={14} className={css.spin}/>:<BarChart2 size={14}/>} Generate BRS
        </button>
      </div>
      {err && <div className={css.validationFail}><AlertCircle size={15}/>{err}</div>}
      {result && (
        <div className={css.card}>
          <div className={css.cardHeader}><span className={css.cardLabel}>Bank Reconciliation Statement — {fmtDate(asAt)}</span></div>
          <div className={css.cardBody}>
            <div className={css.brsTable}>
              <div className={css.brsRow}><span className={css.brsLabel}>Balance as per Bank Statement</span><span className={css.brsValue}>{fmt(result.balance_per_bank as number)}</span></div>
              <Line label="Add: Deposits not yet cleared"   items={(result.cheques_deposited_not_cleared  as BI[])??[]} />
              <Line label="Less: Cheques not yet presented" items={(result.cheques_issued_not_presented   as BI[])??[]} />
              <Line label="Add: Bank credits not in books"  items={(result.bank_credits_not_in_books      as BI[])??[]} />
              <Line label="Less: Bank charges not in books" items={(result.bank_debits_not_in_books       as BI[])??[]} />
              <div className={css.brsRowTotal}><span className={css.brsLabel}>Adjusted Bank Balance</span><span className={css.brsValue}>{fmt(result.adjusted_bank_balance as number)}</span></div>
              <div className={css.brsRow}><span className={css.brsLabel}>Balance as per Books</span><span className={css.brsValue}>{fmt(result.balance_per_books as number)}</span></div>
              <div className={css.brsRowTotal}>
                <span className={css.brsLabel}>Difference</span>
                <span className={\`\${css.brsValue} \${Math.abs(result.difference as number)<0.01?css.brsVariance:css.brsVarianceBad}\`}>{fmt(result.difference as number)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'upload'|'statements'|'workbench'|'queries'|'brs'

export default function BankReconPage() {
  const { user } = useAuth()
  const params   = useParams<{ statementId?: string }>()
  const navigate = useNavigate()
  const companyId = (user as Record<string,unknown>)?.activeCompany?.id as string ?? ''
  const [tab,    setTab]    = useState<Tab>(params.statementId ? 'workbench' : 'upload')
  const [stmtId, setStmtId] = useState<string|null>(params.statementId ?? null)

  if (!companyId) return <div className={css.page}><p style={{ color:'var(--text-muted)', fontSize:'0.875rem' }}>No active company selected.</p></div>

  const TABS: { key:Tab; label:string }[] = [
    { key:'upload',     label:'Upload' },
    { key:'statements', label:'Statements' },
    ...(stmtId ? [{ key:'workbench' as Tab, label:'Match Workbench' }] : []),
    { key:'queries',    label:'Queries' },
    { key:'brs',        label:'BRS Report' },
  ]

  return (
    <div className={css.page}>
      <div className={css.pageHeader}>
        <div className={css.pageTitleBlock}>
          <h1 className={css.pageTitle}>Bank Reconciliation</h1>
          <p className={css.pageSubtitle}>{(user as Record<string,unknown>)?.activeCompany?.name as string ?? ''} · Upload, match &amp; query bank statements</p>
        </div>
      </div>
      {/* overflowX:auto makes the tab bar scroll on mobile instead of wrapping */}
      <div className={css.tabBar} style={{ overflowX:'auto', WebkitOverflowScrolling:'touch', flexShrink:0 }}>
        {TABS.map(t => (
          <button key={t.key} className={\`\${css.tab} \${tab===t.key?css.tabActive:''}\`}
            onClick={() => setTab(t.key)} style={{ flexShrink:0 }}>
            {t.label}
          </button>
        ))}
      </div>
      {tab==='upload'     && <UploadTab companyId={companyId} onComplete={id => { setStmtId(id); setTab('workbench'); navigate(\`/bank-recon/\${id}\`) }} />}
      {tab==='statements' && <StatementsTab companyId={companyId} onSelect={id => { setStmtId(id); setTab('workbench'); navigate(\`/bank-recon/\${id}\`) }} />}
      {tab==='workbench'  && stmtId  && <WorkbenchTab statementId={stmtId} companyId={companyId} />}
      {tab==='workbench'  && !stmtId && <div className={css.emptyState}>Select a statement from the Statements tab first.</div>}
      {tab==='queries'    && <QueriesTab companyId={companyId} />}
      {tab==='brs'        && <BrsTab companyId={companyId} />}
    </div>
  )
}
`

writeFileSync('src/pages/BankReconPage.tsx', content, 'utf8')
console.log('Written', content.length, 'chars,', content.split('\\n').length, 'lines')
