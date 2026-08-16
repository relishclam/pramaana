// ── Compliance Module — Calendar & Dashboard ─────────────────────────────────
// Phase C4 + C1 read surface.
// Shows upcoming/overdue compliance obligations with mark-as-filed workflow.

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle, RefreshCw } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import css from './CompliancePage.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Obligation {
  id: string
  company_id: string
  obligation: string
  period: string | null
  period_from: string | null
  period_to:   string | null
  due_date: string
  status: 'upcoming' | 'in_progress' | 'filed' | 'overdue' | 'na' | 'waived'
  filed_ref: string | null
  filed_date: string | null
  amount_payable: number | null
  amount_paid: number | null
  notes: string | null
}

const STATUS_LABELS: Record<string, string> = {
  upcoming:    'Upcoming',
  in_progress: 'In Progress',
  filed:       'Filed ✓',
  overdue:     'OVERDUE',
  na:          'N/A',
  waived:      'Waived',
}

const STATUS_CSS: Record<string, string> = {
  upcoming:    css.chipUpcoming,
  in_progress: css.chipInProgress,
  filed:       css.chipFiled,
  overdue:     css.chipOverdue,
  na:          css.chipNa,
  waived:      css.chipNa,
}

const OBLIGATION_CATEGORY: Record<string, string> = {
  'GSTR-1': 'GST', 'GSTR-3B': 'GST', 'GSTR-9': 'GST', 'GSTR-9C': 'GST',
  'TDS-deposit': 'TDS', '26Q': 'TDS', '24Q': 'TDS',
  'AOC-4': 'ROC', 'MGT-7': 'ROC', 'DIR-3-KYC': 'ROC', 'ADT-1': 'ROC', 'AGM': 'ROC',
  'ITR': 'IT', '44AB': 'IT',
  'LUT': 'GST', 'QRMP-PMT-06': 'GST',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

const daysUntil = (iso: string) =>
  Math.round((new Date(iso + 'T00:00:00').getTime() - Date.now()) / 86400000)

function DaysLabel({ iso }: { iso: string }) {
  const d = daysUntil(iso)
  if (d < 0)  return <span className={`${css.days} ${css.daysOverdue}`}>({Math.abs(d)}d overdue)</span>
  if (d <= 7) return <span className={`${css.days} ${css.daysImminent}`}>({d}d)</span>
  return <span className={css.days}>({d}d)</span>
}

// ── Mark-Filed Drawer ─────────────────────────────────────────────────────────

function FiledDrawer({
  item, onClose, onSaved,
}: { item: Obligation; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus]       = useState<string>(item.status)
  const [filedRef, setFiledRef]   = useState(item.filed_ref ?? '')
  const [filedDate, setFiledDate] = useState(item.filed_date ?? new Date().toISOString().slice(0, 10))
  const [notes, setNotes]         = useState(item.notes ?? '')
  const [saving, setSaving]       = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token ?? ''
      const res = await fetch(`/api/compliance-obligations?id=${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status, filed_ref: filedRef || null, filed_date: filedDate || null, notes: notes || null }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Save failed' })) as { error?: string }
        alert(err.error ?? 'Save failed')
        return
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={css.drawer} onClick={onClose}>
      <div className={css.drawerPanel} onClick={e => e.stopPropagation()}>
        <h3>Update — {item.obligation} {item.period ? `(${item.period})` : ''}</h3>
        <div className={css.fieldRow}>
          <div className={css.field}>
            <label>Status</label>
            <select value={status} onChange={e => setStatus(e.target.value)}>
              <option value="upcoming">Upcoming</option>
              <option value="in_progress">In Progress</option>
              <option value="filed">Filed ✓</option>
              <option value="na">N/A</option>
              <option value="waived">Waived</option>
            </select>
          </div>
          <div className={css.field}>
            <label>Reference / ARN / CIN</label>
            <input value={filedRef} onChange={e => setFiledRef(e.target.value)}
              placeholder="ARN, acknowledgment no, challan CIN…" />
          </div>
          <div className={css.field}>
            <label>Filed / Paid date</label>
            <input type="date" value={filedDate} onChange={e => setFiledDate(e.target.value)} />
          </div>
          <div className={css.field}>
            <label>Notes</label>
            <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Any remarks…" />
          </div>
        </div>
        <div className={css.drawerActions}>
          <button className={css.btnSecondary} onClick={onClose}>Cancel</button>
          <button className={css.btnPrimary} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const FILTERS = ['All', 'Overdue', 'Upcoming', 'GST', 'TDS', 'ROC', 'IT'] as const

export default function CompliancePage() {
  const { user } = useAuth()
  const companyId = user?.activeCompany?.id

  const [rows, setRows]         = useState<Obligation[]>([])
  const [loading, setLoading]   = useState(true)
  const [filter, setFilter]     = useState<string>('All')
  const [selected, setSelected] = useState<Obligation | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token ?? ''
      const res = await fetch(
        `/api/compliance-obligations?company_id=${companyId}&status=upcoming,in_progress,overdue&limit=100`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const data = await res.json() as unknown
      const pending = Array.isArray(data) ? data as Obligation[] : []
      const res2 = await fetch(
        `/api/compliance-obligations?company_id=${companyId}&status=filed&limit=50`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const data2 = await res2.json() as unknown
      const filed = Array.isArray(data2) ? data2 as Obligation[] : []
      setRows([...pending, ...filed].sort((a, b) => a.due_date.localeCompare(b.due_date)))
    } finally {
      setLoading(false)
    }
  }, [companyId])

  useEffect(() => { load() }, [load])

  // Overdue is derived client-side — stored status only tracks filed/na/waived
  const isOverdue  = (r: Obligation) => r.status !== 'filed' && r.status !== 'na' && r.status !== 'waived' && daysUntil(r.due_date) < 0
  const overdue  = rows.filter(isOverdue).length
  const imminent = rows.filter(r => !isOverdue(r) && r.status !== 'filed' && daysUntil(r.due_date) >= 0 && daysUntil(r.due_date) <= 7).length
  const upcoming = rows.filter(r => !isOverdue(r) && r.status === 'upcoming' && daysUntil(r.due_date) > 7).length

  // ── Filtered rows ──────────────────────────────────────────────────────────
  const visible = rows.filter(r => {
    if (filter === 'All')      return true
    if (filter === 'Overdue')  return isOverdue(r)
    if (filter === 'Upcoming') return !isOverdue(r) && (r.status === 'upcoming' || r.status === 'in_progress')
    return OBLIGATION_CATEGORY[r.obligation] === filter
  })

  const rowCss = (r: Obligation) => {
    if (isOverdue(r))                                               return css.rowOverdue
    if (daysUntil(r.due_date) <= 7 && r.status !== 'filed') return css.rowImminent
    return ''
  }

  return (
    <div className={css.page}>
      <div className={css.header}>
        <h1>Compliance</h1>
        <p>Statutory obligations calendar — FY 2026-27</p>
      </div>

      {/* ── Stats ── */}
      <div className={css.stats}>
        <div className={css.statCard}>
          <div className={css.label}>Overdue</div>
          <div className={`${css.value} ${overdue > 0 ? css.statOverdue : css.statOk}`}>
            {loading ? '…' : overdue}
          </div>
        </div>
        <div className={css.statCard}>
          <div className={css.label}>Due within 7 days</div>
          <div className={`${css.value} ${imminent > 0 ? css.statImminent : css.statOk}`}>
            {loading ? '…' : imminent}
          </div>
        </div>
        <div className={css.statCard}>
          <div className={css.label}>Upcoming</div>
          <div className={`${css.value} ${css.statOk}`}>{loading ? '…' : upcoming}</div>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className={css.controls}>
        {FILTERS.map(f => (
          <button key={f}
            className={`${css.filterBtn} ${filter === f ? css.filterBtnActive : ''}`}
            onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
        <button className={css.actionBtn} onClick={load} style={{ marginLeft: 'auto' }}>
          <RefreshCw size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />
          Refresh
        </button>
      </div>

      {/* ── Table ── */}
      <div className={css.tableWrap}>
        <table>
          <thead>
            <tr>
              <th>Obligation</th>
              <th>Period</th>
              <th>Due Date</th>
              <th>Status</th>
              <th>Reference</th>
              <th>Notes</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: '#888' }}>Loading…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: '#888' }}>
                {filter === 'All' ? 'No obligations loaded' : `No ${filter} obligations`}
              </td></tr>
            ) : visible.map(row => (
              <tr key={row.id} className={rowCss(row)}>
                <td>
                  <strong>{row.obligation}</strong>
                  {OBLIGATION_CATEGORY[row.obligation] && (
                    <span style={{ marginLeft: 6, fontSize: '0.7rem', color: '#888' }}>
                      {OBLIGATION_CATEGORY[row.obligation]}
                    </span>
                  )}
                </td>
                <td>{row.period ?? '—'}</td>
                <td>
                  {fmtDate(row.due_date)}
                  {row.status !== 'filed' && <DaysLabel iso={row.due_date} />}
                </td>
                <td>
                  <span className={STATUS_CSS[row.status] ?? css.chipUpcoming}>
                    {STATUS_LABELS[row.status] ?? row.status}
                  </span>
                </td>
                <td style={{ fontSize: '0.8rem', color: '#aaa' }}>{row.filed_ref ?? '—'}</td>
                <td style={{ fontSize: '0.8rem', color: '#888', maxWidth: 200, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
                    title={row.notes ?? ''}>
                  {row.notes ?? '—'}
                </td>
                </td>
                <td>
                  {row.status !== 'filed' && (
                    <button className={css.actionBtn} onClick={() => setSelected(row)}>
                      Update
                    </button>
                  )}
                  {row.status === 'filed' && (
                    <CheckCircle size={14} color="#4ade80" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Mark-Filed Drawer ── */}
      {selected && (
        <FiledDrawer
          item={selected}
          onClose={() => setSelected(null)}
          onSaved={() => { setSelected(null); load() }}
        />
      )}
    </div>
  )
}
