import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Upload, CheckCircle, AlertCircle, RefreshCw, X, MessageSquare, Send, FileText, BarChart2 } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import {
  fetchBankFormats,
  fetchStatements,
  fetchStatementLines,
  fetchQueryMessages,
  confirmMatch,
  markIgnored,
  unlinkMatch,
  getBrs,
  type BankFormatConfig,
  type BankStatement,
  type BankStatementLine,
  type AuditQuery,
  type AuditQueryMessage,
  type BrsResult,
} from '@/lib/bank-recon'
import css from './BankRecon.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const fmt = (n: number | null | undefined) => n == null ? '—' : inr.format(n)
const fmtDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(',')[1] ?? result)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

const STATUS_LABELS: Record<string, string> = {
  unmatched:     'Unmatched',
  matched:       'Matched',
  fuzzy_matched: 'Fuzzy — confirm',
  confirmed:     'Confirmed',
  unbooked:      'Unbooked',
  queried:       'Queried',
  resolved:      'Resolved',
  ignored:       'Ignored',
}

function StatusChip({ status }: { status: string }) {
  const chipClass: Record<string, string> = {
    matched:       css.chipMatched,
    confirmed:     css.chipConfirmed,
    fuzzy_matched: css.chipFuzzy,
    unbooked:      css.chipUnbooked,
    queried:       css.chipQueried,
    resolved:      css.chipResolved,
    ignored:       css.chipIgnored,
    unmatched:     css.chipUnmatched,
  }
  return <span className={chipClass[status] ?? css.chipUnmatched}>{STATUS_LABELS[status] ?? status}</span>
}

// ── Sub-page: Upload ──────────────────────────────────────────────────────────

function UploadScreen({ companyId, onComplete }: { companyId: string; onComplete: (id: string) => void }) {
  const [formats, setFormats] = useState<BankFormatConfig[]>([])
  const [bankCode, setBankCode] = useState('')
  const [periodFrom, setPeriodFrom] = useState('')
  const [periodTo, setPeriodTo] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [steps, setSteps] = useState<{ label: string; state: 'idle' | 'active' | 'done' | 'error' }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchBankFormats(companyId)
      .then(f => setFormats(f.filter(b => b.active)))
      .catch(e => setError(e.message))
  }, [companyId])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) setFile(f)
  }, [])

  const handleUpload = async () => {
    if (!bankCode || !periodFrom || !periodTo || !file) {
      setError('All fields required'); return
    }
    setSubmitting(true)
    setError(null)
    setSteps([
      { label: 'Uploading file…', state: 'active' },
      { label: 'Parsing statement…', state: 'idle' },
      { label: 'Running match engine…', state: 'idle' },
    ])

    try {
      const base64 = await toBase64(file)
      const token = supabase.auth
        .getSession().then(s => s.data.session?.access_token ?? '')

      // Step 1: upload
      const upRes = await fetch('/api/bank-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token}` },
        body: JSON.stringify({
          company_id: companyId, bank_code: bankCode,
          period_from: periodFrom, period_to: periodTo,
          file_name: file.name, file_type: file.type, file_base64: base64,
        }),
      })
      const upData = await upRes.json() as { statement_id?: string; error?: string }
      if (!upRes.ok || !upData.statement_id) throw new Error(upData.error ?? 'Upload failed')
      const statement_id = upData.statement_id

      setSteps(s => s.map((x, i) => i === 0 ? { ...x, state: 'done' } : i === 1 ? { ...x, state: 'active' } : x))

      // Step 2: parse
      const parseRes = await fetch('/api/bank-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statement_id }),
      })
      const parseData = await parseRes.json() as { lines_parsed?: number; opening_balance?: number; closing_balance?: number; error?: string }
      if (!parseRes.ok) throw new Error(parseData.error ?? 'Parse failed')

      setSteps(s => s.map((x, i) => i === 1 ? { ...x, state: 'done' } : i === 2 ? { ...x, state: 'active' } : x))

      // Step 3: match
      const matchRes = await fetch('/api/bank-match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statement_id }),
      })
      const matchData = await matchRes.json() as Record<string, number>
      if (!matchRes.ok) throw new Error((matchData as { error?: string }).error ?? 'Match failed')

      setSteps(s => s.map((x, i) => i === 2 ? { ...x, state: 'done' } : x))

      // Show summary then hand off
      setTimeout(() => onComplete(statement_id), 1200)

    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Upload failed'
      setError(msg)
      setSteps(s => s.map(x => x.state === 'active' ? { ...x, state: 'error' } : x))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={css.card}>
      <div className={css.cardHeader}>
        <span className={css.cardLabel}>Upload bank statement</span>
      </div>
      <div className={css.cardBody}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.875rem', marginBottom: '1rem' }}>
          <div className={css.field}>
            <label className={css.label}>Bank</label>
            <select className={css.select} value={bankCode} onChange={e => setBankCode(e.target.value)}>
              <option value="">Select bank…</option>
              {formats.map(f => <option key={f.id} value={f.bank_code}>{f.bank_code}</option>)}
            </select>
          </div>
          <div className={css.field}>
            <label className={css.label}>Period from</label>
            <input type="date" className={css.input} value={periodFrom} onChange={e => setPeriodFrom(e.target.value)} />
          </div>
          <div className={css.field}>
            <label className={css.label}>Period to</label>
            <input type="date" className={css.input} value={periodTo} onChange={e => setPeriodTo(e.target.value)} />
          </div>
        </div>

        <div
          className={`${css.dropZone} ${dragging ? css.dropZoneActive : ''}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <Upload size={28} className={css.dropZoneIcon} />
          {file
            ? <span className={css.dropZoneText}>{file.name} ({(file.size / 1024).toFixed(0)} KB)</span>
            : <><span className={css.dropZoneText}>Drop CSV / JSON here, or click to browse</span>
               <span className={css.dropZoneHint}>XLSX: export as CSV from bank portal first</span></>
          }
          <input ref={fileRef} type="file" accept=".csv,.json" style={{ display: 'none' }}
            onChange={e => { if (e.target.files?.[0]) setFile(e.target.files[0]) }} />
        </div>

        {steps.length > 0 && (
          <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            {steps.map((s, i) => (
              <div key={i} className={css.progressRow}>
                {s.state === 'done'   && <CheckCircle size={14} color="var(--success)" />}
                {s.state === 'active' && <RefreshCw size={14} className={css.spin} color="var(--teal)" />}
                {s.state === 'error'  && <AlertCircle size={14} color="var(--error)" />}
                {s.state === 'idle'   && <span style={{ width: 14 }} />}
                <span className={s.state === 'active' ? css.progressStepActive : s.state === 'done' ? css.progressStepDone : css.progressStep}>
                  {s.label}
                </span>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className={css.validationFail} style={{ marginTop: '0.75rem' }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{error}</span>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button className={css.btnPrimary} onClick={handleUpload} disabled={submitting || !bankCode || !periodFrom || !periodTo || !file}>
            {submitting ? 'Processing…' : 'Upload & parse'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sub-page: Statement list ──────────────────────────────────────────────────

function StatementList({ companyId, onSelect }: { companyId: string; onSelect: (id: string) => void }) {
  const [stmts, setStmts] = useState<BankStatement[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStatements(companyId)
      .then(setStmts)
      .finally(() => setLoading(false))
  }, [companyId])

  if (loading) return <div className={css.loading}><RefreshCw size={16} className={css.spin} /> Loading…</div>
  if (!stmts.length) return <div className={css.emptyState}>No statements uploaded yet.</div>

  return (
    <div className={css.card}>
      <div className={css.cardHeader}><span className={css.cardLabel}>Uploaded statements</span></div>
      <div className={css.stmtList}>
        {stmts.map(s => (
          <div key={s.id} className={css.stmtRow} onClick={() => onSelect(s.id)}>
            <span className={css.stmtBank}>{(s.bank_format_config as { bank_code?: string })?.bank_code ?? '—'}</span>
            <span className={css.stmtPeriod}>{fmtDate(s.period_from)} → {fmtDate(s.period_to)}</span>
            <span className={css.stmtLines}>{s.line_count ?? 0} lines</span>
            <StatusChip status={s.status} />
            {s.parse_error && <span title={s.parse_error}><AlertCircle size={14} color="var(--error)" /></span>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Sub-page: Match workbench ─────────────────────────────────────────────────

const ALL_STATUSES = ['unmatched','matched','fuzzy_matched','confirmed','unbooked','queried','resolved','ignored']

function MatchWorkbench({ statementId, companyId }: { statementId: string; companyId: string }) {
  const [lines, setLines] = useState<BankStatementLine[]>([])
  const [filter, setFilter] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [querySubject, setQuerySubject] = useState('')
  const [queryMsg, setQueryMsg] = useState('')
  const [submittingQuery, setSubmittingQuery] = useState(false)
  const [ignoreNote, setIgnoreNote] = useState('')
  const [ignoreTarget, setIgnoreTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    fetchStatementLines(statementId, filter.length ? filter : undefined)
      .then(setLines)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [statementId, filter])

  useEffect(() => { reload() }, [reload])

  const counts = lines.reduce<Record<string, number>>((acc, l) => {
    acc[l.match_status] = (acc[l.match_status] ?? 0) + 1; return acc
  }, {})

  const visible = filter.length ? lines.filter(l => filter.includes(l.match_status)) : lines

  const toggleFilter = (s: string) =>
    setFilter(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])

  const toggleSelect = (id: string) =>
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const handleConfirm = async (id: string) => {
    try { await confirmMatch(id); reload() } catch (e) { setError((e as Error).message) }
  }

  const handleUnlink = async (id: string) => {
    try { await unlinkMatch(id); reload() } catch (e) { setError((e as Error).message) }
  }

  const handleIgnore = async () => {
    if (!ignoreTarget || !ignoreNote.trim()) return
    try {
      await markIgnored(ignoreTarget, ignoreNote)
      setIgnoreTarget(null); setIgnoreNote(''); reload()
    } catch (e) { setError((e as Error).message) }
  }

  const handleRaiseQuery = async () => {
    if (!querySubject.trim() || !queryMsg.trim() || !selected.size) return
    setSubmittingQuery(true)
    try {
      const token = await supabase.auth
        .getSession().then(s => s.data.session?.access_token ?? '')
      const res = await fetch('/api/bank-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: 'create',
          company_id: companyId,
          subject: querySubject,
          line_ids: [...selected],
          message: queryMsg,
        }),
      })
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Failed')
      setSelected(new Set()); setQuerySubject(''); setQueryMsg(''); reload()
    } catch (e) { setError((e as Error).message) }
    finally { setSubmittingQuery(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Stats */}
      <div className={css.card}>
        <div className={css.statGrid}>
          {(['matched','confirmed','fuzzy_matched','unbooked'] as const).map(s => (
            <div key={s} className={css.stat}>
              <div className={css.statLabel}>{STATUS_LABELS[s]}</div>
              <div className={
                s === 'matched' || s === 'confirmed' ? css.statValueTeal
                : s === 'unbooked' ? css.statValueError
                : css.statValueAmber
              }>{counts[s] ?? 0}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Filter pills */}
      <div className={css.filterBar}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginRight: '0.25rem' }}>Filter:</span>
        {ALL_STATUSES.filter(s => (counts[s] ?? 0) > 0).map(s => (
          <button key={s} className={`${css.filterPill} ${filter.includes(s) ? css.filterPillActive : ''}`}
            onClick={() => toggleFilter(s)}>
            {STATUS_LABELS[s]}
            <span className={css.pillCount}>{counts[s] ?? 0}</span>
          </button>
        ))}
        {filter.length > 0 && <button className={css.btnGhost} onClick={() => setFilter([])}>Clear</button>}
      </div>

      {/* Query composer — shown when lines selected */}
      {selected.size > 0 && (
        <div className={`${css.card} ${css.queryComposer}`}>
          <div className={css.cardHeader}>
            <span className={css.cardLabel}>{selected.size} line{selected.size > 1 ? 's' : ''} selected — raise query</span>
            <button className={css.btnGhost} onClick={() => setSelected(new Set())}><X size={14} /></button>
          </div>
          <div className={css.cardBody}>
            <div className={css.querySubjectRow}>
              <div className={css.field}>
                <label className={css.label}>Subject</label>
                <input className={css.input} placeholder="e.g. Unbooked Federal credit Apr-26"
                  value={querySubject} onChange={e => setQuerySubject(e.target.value)} />
              </div>
              <button className={css.btnPrimary} onClick={handleRaiseQuery}
                disabled={submittingQuery || !querySubject.trim() || !queryMsg.trim()}>
                <Send size={13} />{submittingQuery ? 'Raising…' : 'Raise query'}
              </button>
            </div>
            <div className={css.field} style={{ marginTop: '0.5rem' }}>
              <label className={css.label}>First message</label>
              <textarea className={css.input} rows={2} style={{ resize: 'vertical' }}
                placeholder="Describe the issue or question…"
                value={queryMsg} onChange={e => setQueryMsg(e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {/* Lines table */}
      {loading ? (
        <div className={css.loading}><RefreshCw size={16} className={css.spin} /> Loading lines…</div>
      ) : !visible.length ? (
        <div className={css.emptyState}>No lines match the current filter.</div>
      ) : (
        <div className={`${css.card} ${css.tableWrap}`}>
          <table className={css.table}>
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th>Date</th>
                <th>Narration</th>
                <th>Ref</th>
                <th className={css.right}>Credit</th>
                <th className={css.right}>Debit</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(l => (
                <tr key={l.id} className={`${css.tableRow} ${selected.has(l.id) ? css.tableRowSelected : ''}`}
                  onClick={() => toggleSelect(l.id)}>
                  <td onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(l.id)}
                      onChange={() => toggleSelect(l.id)} style={{ accentColor: 'var(--teal)' }} />
                  </td>
                  <td className={css.mutedText}>{fmtDate(l.txn_date)}</td>
                  <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.narration ?? '—'}
                  </td>
                  <td className={css.mutedText}>{l.ref_no ?? '—'}</td>
                  <td className={css.right}>
                    {l.credit > 0 ? <span className={css.creditAmt}>{fmt(l.credit)}</span> : '—'}
                  </td>
                  <td className={css.right}>
                    {l.debit > 0 ? <span className={css.debitAmt}>{fmt(l.debit)}</span> : '—'}
                  </td>
                  <td><StatusChip status={l.match_status} /></td>
                  <td onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                    {l.match_status === 'fuzzy_matched' &&
                      <button className={css.btnGhost} onClick={() => handleConfirm(l.id)}>
                        <CheckCircle size={12} /> Confirm
                      </button>}
                    {(l.match_status === 'matched' || l.match_status === 'fuzzy_matched' || l.match_status === 'confirmed') &&
                      <button className={css.btnGhost} onClick={() => handleUnlink(l.id)}>
                        <X size={12} /> Unlink
                      </button>}
                    {!['ignored','resolved'].includes(l.match_status) &&
                      <button className={css.btnDanger}
                        onClick={() => { setIgnoreTarget(l.id); setIgnoreNote('') }}>
                        Ignore
                      </button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Ignore modal */}
      {ignoreTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div className={css.card} style={{ width: 400, margin: '1rem' }}>
            <div className={css.cardHeader}>
              <span className={css.cardLabel}>Ignore line — add note</span>
              <button className={css.btnGhost} onClick={() => setIgnoreTarget(null)}><X size={14} /></button>
            </div>
            <div className={css.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div className={css.field}>
                <label className={css.label}>Reason (required)</label>
                <input className={css.input} placeholder="e.g. Contra entry, duplicate line…"
                  value={ignoreNote} onChange={e => setIgnoreNote(e.target.value)} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button className={css.btnSecondary} onClick={() => setIgnoreTarget(null)}>Cancel</button>
                <button className={css.btnPrimary} onClick={handleIgnore} disabled={!ignoreNote.trim()}>
                  Mark ignored
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className={css.validationFail}>
          <AlertCircle size={14} style={{ flexShrink: 0 }} /><span>{error}</span>
          <button className={css.btnGhost} style={{ marginLeft: 'auto' }} onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}
    </div>
  )
}

// ── Sub-page: Query thread ────────────────────────────────────────────────────

function QueryThread({ query, companyId, onClose }: { query: AuditQuery; companyId: string; onClose: () => void }) {
  const { user } = useAuth()
  const [messages, setMessages] = useState<AuditQueryMessage[]>([])
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchQueryMessages(query.id).then(setMessages).catch(e => setError(e.message))
  }, [query.id])

  const handleReply = async () => {
    if (!reply.trim()) return
    setSending(true)
    try {
      const token = await supabase.auth
        .getSession().then(s => s.data.session?.access_token ?? '')
      const res = await fetch('/api/bank-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'respond', query_id: query.id, body: reply }),
      })
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Failed')
      setReply('')
      fetchQueryMessages(query.id).then(setMessages)
    } catch (e) { setError((e as Error).message) }
    finally { setSending(false) }
  }

  const handleClose = async (withVoucher?: string) => {
    try {
      const token = await supabase.auth
        .getSession().then(s => s.data.session?.access_token ?? '')
      await fetch('/api/bank-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'close', query_id: query.id, resolution_voucher_id: withVoucher }),
      })
      onClose()
    } catch (e) { setError((e as Error).message) }
  }

  const navigate = useNavigate()

  return (
    <div className={css.card}>
      <div className={css.cardHeader}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', color: 'var(--teal)' }}>
            {query.query_no}
          </span>
          <span className={css.cardLabel}>{query.subject}</span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <StatusChip status={query.status} />
          <button className={css.btnGhost} onClick={onClose}><X size={14} /></button>
        </div>
      </div>
      <div className={css.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        <div className={css.thread}>
          {messages.map(m => (
            <div key={m.id} className={css.message}>
              <div className={css.messageMeta}>
                <span className={css.messageAuthor}>{m.author_id === user?.profile.id ? 'You' : 'Accountant'}</span>
                <span className={css.messageTime}>{new Date(m.created_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</span>
              </div>
              <div className={css.messageBody}>{m.body}</div>
            </div>
          ))}
        </div>

        {query.status !== 'closed' && query.status !== 'rectified' && (
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input className={css.input} style={{ flex: 1 }} placeholder="Reply…"
              value={reply} onChange={e => setReply(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleReply() } }} />
            <button className={css.btnPrimary} onClick={handleReply} disabled={sending || !reply.trim()}>
              <Send size={13} />{sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button className={css.btnSecondary}
            onClick={() => navigate('/vouchers/new', { state: { source: 'bank_import', query_id: query.id } })}>
            <FileText size={13} /> Create rectification voucher
          </button>
          {query.status !== 'closed' && (
            <button className={css.btnGhost} onClick={() => handleClose()}>Mark closed</button>
          )}
        </div>

        {error && (
          <div className={css.validationFail}>
            <AlertCircle size={14} style={{ flexShrink: 0 }} /><span>{error}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sub-page: BRS Report ──────────────────────────────────────────────────────

function BrsReport({ companyId }: { companyId: string }) {
  const [formats, setFormats] = useState<BankFormatConfig[]>([])
  const [bankFormatId, setBankFormatId] = useState('')
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10))
  const [brs, setBrs] = useState<BrsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchBankFormats(companyId)
      .then(f => setFormats(f.filter(b => b.active)))
      .catch(e => setError(e.message))
  }, [companyId])

  const run = async () => {
    const fmt = formats.find(f => f.id === bankFormatId)
    if (!fmt) return
    setLoading(true); setError(null)
    try {
      const result = await getBrs(fmt.bank_ledger_id, asOf, companyId)
      setBrs(result)
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className={css.card}>
        <div className={css.cardHeader}><span className={css.cardLabel}>Bank Reconciliation Statement</span></div>
        <div className={css.cardBody}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px auto', gap: '0.875rem', alignItems: 'end' }}>
            <div className={css.field}>
              <label className={css.label}>Bank</label>
              <select className={css.select} value={bankFormatId} onChange={e => setBankFormatId(e.target.value)}>
                <option value="">Select bank…</option>
                {formats.map(f => <option key={f.id} value={f.id}>{f.bank_code}</option>)}
              </select>
            </div>
            <div className={css.field}>
              <label className={css.label}>As of date</label>
              <input type="date" className={css.input} value={asOf} onChange={e => setAsOf(e.target.value)} />
            </div>
            <button className={css.btnPrimary} onClick={run} disabled={loading || !bankFormatId}>
              {loading ? <RefreshCw size={13} className={css.spin} /> : <BarChart2 size={13} />}
              {loading ? 'Computing…' : 'Generate BRS'}
            </button>
          </div>
        </div>
      </div>

      {error && <div className={css.validationFail}><AlertCircle size={14} /><span>{error}</span></div>}

      {brs && (
        <div className={css.card}>
          <div className={css.cardHeader}>
            <span className={css.cardLabel}>BRS as of {fmtDate(asOf)}</span>
            <button className={css.btnGhost} onClick={() => window.print()}>Print</button>
          </div>
          <div className={css.cardBody}>
            <div className={css.brsTable}>
              <div className={css.brsRow}>
                <span className={css.brsLabel}>Balance as per books (bank ledger)</span>
                <span className={css.brsValue}>{fmt(brs.book_balance)}</span>
              </div>
              <div className={css.brsRow}>
                <span className={css.brsLabel}>Less: Cheques issued not yet presented</span>
                <span className={css.brsValue} style={{ color: 'var(--error)' }}>({fmt(brs.less_uncleared_cheques)})</span>
              </div>
              <div className={css.brsRow}>
                <span className={css.brsLabel}>Add: Deposits in transit</span>
                <span className={css.brsValue} style={{ color: 'var(--success)' }}>{fmt(brs.add_deposits_in_transit)}</span>
              </div>
              <div className={css.brsRow}>
                <span className={css.brsLabel}>Add: Unbooked bank credits</span>
                <span className={css.brsValue} style={{ color: 'var(--success)' }}>{fmt(brs.add_unbooked_credits)}</span>
              </div>
              <div className={css.brsRow}>
                <span className={css.brsLabel}>Less: Unbooked bank debits</span>
                <span className={css.brsValue} style={{ color: 'var(--error)' }}>({fmt(brs.less_unbooked_debits)})</span>
              </div>
              <div className={css.brsRowTotal}>
                <span className={css.brsLabel} style={{ fontWeight: 700 }}>Derived bank balance</span>
                <span className={css.brsValue}>{fmt(brs.derived_bank_balance)}</span>
              </div>
              {brs.statement_closing_balance != null && (
                <>
                  <div className={css.brsRow} style={{ marginTop: '0.5rem' }}>
                    <span className={css.brsLabel}>Balance as per bank statement</span>
                    <span className={css.brsValue}>{fmt(brs.statement_closing_balance)}</span>
                  </div>
                  <div className={css.brsRow}>
                    <span className={css.brsLabel} style={{ fontWeight: 700 }}>
                      Variance {Math.abs(brs.variance) < 0.01 ? '✓ Nil' : ''}
                    </span>
                    <span className={Math.abs(brs.variance) < 0.01 ? css.brsVariance : css.brsVarianceBad}>
                      {fmt(brs.variance)}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Screen = 'statements' | 'upload' | 'workbench' | 'queries' | 'brs'

export default function BankReconPage() {
  const { user } = useAuth()
  const params = useParams<{ statementId?: string }>()
  const navigate = useNavigate()

  const companyId = user?.activeCompany?.id ?? ''

  const [screen, setScreen] = useState<Screen>(params.statementId ? 'workbench' : 'statements')
  const [activeStatementId, setActiveStatementId] = useState<string | null>(params.statementId ?? null)
  const [activeQuery, setActiveQuery] = useState<AuditQuery | null>(null)

  if (!companyId) {
    return (
      <div className={css.page}>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>No active company selected.</p>
      </div>
    )
  }

  const handleStatementSelect = (id: string) => {
    setActiveStatementId(id)
    setScreen('workbench')
    navigate(`/bank-recon/${id}`)
  }

  const handleUploadComplete = (id: string) => {
    setActiveStatementId(id)
    setScreen('workbench')
    navigate(`/bank-recon/${id}`)
  }

  const TABS: { key: Screen; label: string }[] = [
    { key: 'statements', label: 'Statements' },
    { key: 'upload',     label: 'Upload' },
    ...(activeStatementId ? [{ key: 'workbench' as Screen, label: 'Match workbench' }] : []),
    { key: 'queries',    label: 'Queries' },
    { key: 'brs',        label: 'BRS Report' },
  ]

  return (
    <div className={css.page}>
      <div className={css.pageHeader}>
        <div className={css.pageTitleBlock}>
          <h1 className={css.pageTitle}>Bank Reconciliation</h1>
          <p className={css.pageSubtitle}>{user?.activeCompany?.name ?? ''} · Upload, match & query bank statements</p>
        </div>
      </div>

      <div className={css.tabBar}>
        {TABS.map(t => (
          <button key={t.key} className={`${css.tab} ${screen === t.key ? css.tabActive : ''}`}
            onClick={() => setScreen(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {screen === 'statements' && (
        <StatementList companyId={companyId} onSelect={handleStatementSelect} />
      )}

      {screen === 'upload' && (
        <UploadScreen companyId={companyId} onComplete={handleUploadComplete} />
      )}

      {screen === 'workbench' && activeStatementId && !activeQuery && (
        <MatchWorkbench statementId={activeStatementId} companyId={companyId} />
      )}

      {screen === 'workbench' && activeQuery && (
        <QueryThread query={activeQuery} companyId={companyId} onClose={() => setActiveQuery(null)} />
      )}

      {screen === 'queries' && (
        <div className={css.emptyState}>
          <MessageSquare size={24} style={{ marginBottom: '0.5rem', color: 'var(--text-dim)' }} />
          <p>Select a statement and use the workbench to raise queries.</p>
        </div>
      )}

      {screen === 'brs' && <BrsReport companyId={companyId} />}
    </div>
  )
}
