import { useState, useMemo } from 'react'
import FoodStreamMini from '@/components/FoodStreamMini'
import { Loader2, Printer, FileBarChart2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchDayBook,
  currentFY,
  fmtDate,
  fmtAmt,
  type DayBookRow,
} from '@/lib/reports'
import styles from './Reports.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupByDate(rows: DayBookRow[]): [string, DayBookRow[]][] {
  const map = new Map<string, DayBookRow[]>()
  for (const r of rows) {
    if (!map.has(r.voucher_date)) map.set(r.voucher_date, [])
    map.get(r.voucher_date)!.push(r)
  }
  return [...map.entries()]
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DayBook() {
  const { user } = useAuth()
  const companyId = user?.activeCompany?.id   ?? ''
  const company   = user?.activeCompany

  const fy = currentFY()
  const [from,    setFrom]    = useState(fy.from)
  const [to,      setTo]      = useState(fy.to)
  const [rows,    setRows]    = useState<DayBookRow[]>([])
  const [loading, setLoading] = useState(false)
  const [hasRun,  setHasRun]  = useState(false)

  const runReport = async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const data = await fetchDayBook(companyId, from, to)
      setRows(data)
      setHasRun(true)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load Day Book')
    } finally {
      setLoading(false)
    }
  }

  const grouped = useMemo(() => groupByDate(rows), [rows])
  const total   = useMemo(() => rows.reduce((s, r) => s + r.amount, 0), [rows])

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={`${styles.pageHeader} ${styles.noPrint}`}>
        <h1 className={styles.pageTitle}>Day Book</h1>
        <div className={styles.headerActions}>
          <button className={styles.btnPrint} onClick={() => window.print()}>
            <Printer size={13} /> Print / PDF
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className={`${styles.filterBar} ${styles.noPrint}`}>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>From</label>
          <input
            type="date"
            className={styles.filterInput}
            value={from}
            onChange={e => setFrom(e.target.value)}
          />
        </div>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>To</label>
          <input
            type="date"
            className={styles.filterInput}
            value={to}
            onChange={e => setTo(e.target.value)}
          />
        </div>
        <button className={styles.btnRun} onClick={runReport} disabled={loading || !from || !to}>
          {loading
            ? <><Loader2 size={13} className={styles.spin} /> Loading…</>
            : 'Run Report'
          }
        </button>
      </div>

      {/* Report */}
      {loading ? (
        <FoodStreamMini />
      ) : !hasRun ? (
        <div className={styles.noData}>
          <FileBarChart2 size={36} style={{ opacity: 0.3 }} />
          <span>Set the date range above and click Run Report</span>
        </div>
      ) : (
        <div className={styles.reportDoc}>
          {/* Document meta */}
          <div className={styles.reportMeta}>
            <div className={styles.reportCompany}>{company?.name ?? '—'}</div>
            <div className={styles.reportName}>Day Book</div>
            <div className={styles.reportPeriod}>
              {fmtDate(from)} — {fmtDate(to)}
              &nbsp;·&nbsp;{rows.length} voucher{rows.length !== 1 ? 's' : ''}
            </div>
          </div>

          {rows.length === 0 ? (
            <div className={styles.noData}>No posted vouchers in this period.</div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Voucher No.</th>
                    <th>Type</th>
                    <th>Party</th>
                    <th>Narration</th>
                    <th className={styles.right}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map(([date, dayRows]) => (
                    <>
                      <tr key={`d-${date}`} className={styles.dateGroupRow}>
                        <td colSpan={5}>{fmtDate(date)}</td>
                      </tr>
                      {dayRows.map(r => (
                        <tr key={r.id}>
                          <td className={styles.mono}>{r.voucher_number}</td>
                          <td className={styles.dim}>{r.voucher_type_name}</td>
                          <td>{r.party_name ?? <span className={styles.dim}>—</span>}</td>
                          <td className={styles.dim}>{r.narration ?? '—'}</td>
                          <td className={`${styles.right} ${styles.mono}`}>{fmtAmt(r.amount)}</td>
                        </tr>
                      ))}
                    </>
                  ))}
                </tbody>
                <tfoot>
                  <tr className={styles.grandTotalRow}>
                    <td colSpan={4}>Grand Total</td>
                    <td className={`${styles.right} ${styles.mono}`}>{fmtAmt(total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
