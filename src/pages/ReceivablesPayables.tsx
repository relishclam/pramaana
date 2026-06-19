import { useState, useMemo, useCallback } from 'react'
import { Loader2, Printer, FileBarChart2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchOutstandingLedgers,
  currentFY,
  fmtDate,
  fmtAmt,
  type OutstandingLedger,
  type LedgerNature,
} from '@/lib/reports'
import styles from './Reports.module.css'

type Mode = 'both' | 'receivable' | 'payable'

// ── Helpers ───────────────────────────────────────────────────────────────────

function totals(list: OutstandingLedger[]) {
  return {
    balance: list.reduce((s, r) => s + Math.abs(r.net_balance), 0),
    current: list.reduce((s, r) => s + r.aging.current, 0),
    b31_60:  list.reduce((s, r) => s + r.aging.b31_60,  0),
    b61_90:  list.reduce((s, r) => s + r.aging.b61_90,  0),
    b90plus: list.reduce((s, r) => s + r.aging.b90plus, 0),
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReceivablesPayables() {
  const { user }  = useAuth()
  const companyId = user?.activeCompany?.id ?? ''
  const company   = user?.activeCompany

  const fy = currentFY()
  const [asAt,    setAsAt]    = useState(fy.to)
  const [mode,    setMode]    = useState<Mode>('both')
  const [search,  setSearch]  = useState('')
  const [rows,    setRows]    = useState<OutstandingLedger[]>([])
  const [loading, setLoading] = useState(false)
  const [hasRun,  setHasRun]  = useState(false)

  const runReport = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const natures: LedgerNature[] =
        mode === 'receivable' ? ['ASSET'] :
        mode === 'payable'    ? ['LIABILITY'] :
        ['ASSET', 'LIABILITY']
      const data = await fetchOutstandingLedgers(companyId, asAt, natures)
      setRows(data)
      setHasRun(true)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load outstanding ledgers')
    } finally {
      setLoading(false)
    }
  }, [companyId, asAt, mode])

  const filtered = useMemo(() =>
    rows.filter(r =>
      !search ||
      r.ledger_name.toLowerCase().includes(search.toLowerCase()) ||
      r.group_name.toLowerCase().includes(search.toLowerCase())
    ),
    [rows, search]
  )

  const receivables = filtered.filter(r => r.group_nature === 'ASSET')
  const payables    = filtered.filter(r => r.group_nature === 'LIABILITY')

  const renderTable = (list: OutstandingLedger[], title: string) => {
    if (!list.length) return null
    const t = totals(list)
    return (
      <div style={{ marginBottom: '2.5rem' }}>
        <div style={{
          padding: '0.5rem 0.75rem',
          background: 'var(--surface-2)',
          borderBottom: '1px solid var(--border)',
          fontSize: '0.6875rem',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase' as const,
          color: 'var(--text-muted)',
        }}>
          {title}
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Ledger</th>
                <th>Group</th>
                <th className={styles.right}>Total Outstanding</th>
                <th className={styles.right}>0–30 Days</th>
                <th className={styles.right}>31–60 Days</th>
                <th className={styles.right}>61–90 Days</th>
                <th className={styles.right}>90+ Days</th>
              </tr>
            </thead>
            <tbody>
              {list.map(r => (
                <tr key={r.ledger_id}>
                  <td>{r.ledger_name}</td>
                  <td className={styles.dim}>{r.group_name}</td>
                  <td className={`${styles.right} ${styles.drValue}`}>
                    {fmtAmt(Math.abs(r.net_balance))}
                  </td>
                  <td className={styles.right}>
                    {r.aging.current > 0.005 ? fmtAmt(r.aging.current) : <span className={styles.dim}>—</span>}
                  </td>
                  <td className={styles.right}>
                    {r.aging.b31_60  > 0.005 ? fmtAmt(r.aging.b31_60)  : <span className={styles.dim}>—</span>}
                  </td>
                  <td className={styles.right}>
                    {r.aging.b61_90  > 0.005 ? fmtAmt(r.aging.b61_90)  : <span className={styles.dim}>—</span>}
                  </td>
                  <td className={`${styles.right} ${r.aging.b90plus > 0.005 ? styles.crValue : ''}`}>
                    {r.aging.b90plus > 0.005 ? fmtAmt(r.aging.b90plus) : <span className={styles.dim}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className={styles.grandTotalRow}>
                <td colSpan={2}><strong>Total</strong></td>
                <td className={`${styles.right} ${styles.drValue}`}>{fmtAmt(t.balance)}</td>
                <td className={styles.right}>{fmtAmt(t.current)}</td>
                <td className={styles.right}>{fmtAmt(t.b31_60)}</td>
                <td className={styles.right}>{fmtAmt(t.b61_90)}</td>
                <td className={`${styles.right} ${styles.crValue}`}>{fmtAmt(t.b90plus)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={`${styles.pageHeader} ${styles.noPrint}`}>
        <h1 className={styles.pageTitle}>Receivables &amp; Payables</h1>
        <div className={styles.headerActions}>
          <button className={styles.btnPrint} onClick={() => window.print()}>
            <Printer size={13} /> Print / PDF
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className={`${styles.filterBar} ${styles.noPrint}`}>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>As at date</label>
          <input
            type="date"
            className={styles.filterInput}
            value={asAt}
            onChange={e => setAsAt(e.target.value)}
          />
        </div>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Show</label>
          <select
            className={styles.filterSelect}
            value={mode}
            onChange={e => setMode(e.target.value as Mode)}
          >
            <option value="both">Receivables &amp; Payables</option>
            <option value="receivable">Receivables only</option>
            <option value="payable">Payables only</option>
          </select>
        </div>
        <button className={styles.btnRun} onClick={runReport} disabled={loading || !asAt}>
          {loading
            ? <><Loader2 size={13} className={styles.spin} /> Loading…</>
            : 'Run Report'
          }
        </button>
        {hasRun && (
          <div className={styles.filterGroup} style={{ marginLeft: 'auto' }}>
            <label className={styles.filterLabel}>Search ledger</label>
            <div className={styles.filterSearchWrap}>
              <Search size={13} className={styles.filterSearchIcon} />
              <input
                className={styles.filterSearch}
                placeholder="Ledger or group name…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className={styles.loading}>
          <Loader2 size={20} className={styles.spin} /> Fetching outstanding balances…
        </div>
      ) : !hasRun ? (
        <div className={styles.noData}>
          <FileBarChart2 size={36} style={{ opacity: 0.3 }} />
          <span>Select date &amp; mode, then click Run Report</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.noData}>
          <span>No outstanding balances found for the selected criteria.</span>
        </div>
      ) : (
        <div className={styles.reportDoc}>
          <div className={styles.reportMeta}>
            <div className={styles.reportCompany}>{company?.name ?? '—'}</div>
            <div className={styles.reportName}>Outstanding Analysis (Aging)</div>
            <div className={styles.reportPeriod}>As at {fmtDate(asAt)}</div>
          </div>

          <div style={{ padding: '1.5rem' }}>
            {renderTable(receivables, 'Receivables — Debtors / Trade Receivables')}
            {renderTable(payables,    'Payables — Creditors / Trade Payables')}

            {/* Overall summary */}
            {receivables.length > 0 && payables.length > 0 && (() => {
              const tr = totals(receivables)
              const tp = totals(payables)
              return (
                <div style={{
                  marginTop: '0.5rem',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: '1rem 1.25rem',
                  display: 'flex',
                  gap: '2rem',
                  flexWrap: 'wrap' as const,
                }}>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                      Total Receivables
                    </div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--teal)' }}>
                      {fmtAmt(tr.balance)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                      Total Payables
                    </div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--error)' }}>
                      {fmtAmt(tp.balance)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                      Net Position
                    </div>
                    <div style={{
                      fontSize: '1.25rem', fontWeight: 700, fontFamily: 'var(--font-mono)',
                      color: tr.balance - tp.balance >= 0 ? 'var(--success)' : 'var(--error)',
                    }}>
                      {fmtAmt(Math.abs(tr.balance - tp.balance))}
                      <span style={{ fontSize: '0.75rem', marginLeft: '0.25rem' }}>
                        {tr.balance - tp.balance >= 0 ? 'Net Dr' : 'Net Cr'}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
