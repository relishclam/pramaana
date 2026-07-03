import { useState, useMemo } from 'react'
import FoodStreamMini from '@/components/FoodStreamMini'
import { Loader2, Printer, FileBarChart2, CheckCircle, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchTrialBalance,
  currentFY,
  fmtDate,
  fmtAmt,
  type TrialBalanceLedgerRow,
  type TrialBalanceResult,
} from '@/lib/reports'
import styles from './Reports.module.css'

// ── Group rows by ledger group name ──────────────────────────────────────────

function groupRows(rows: TrialBalanceLedgerRow[]): [string, TrialBalanceLedgerRow[]][] {
  const map = new Map<string, TrialBalanceLedgerRow[]>()
  for (const r of rows) {
    if (!map.has(r.group_name)) map.set(r.group_name, [])
    map.get(r.group_name)!.push(r)
  }
  return [...map.entries()]
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TrialBalance() {
  const { user } = useAuth()
  const companyId = user?.activeCompany?.id ?? ''
  const company   = user?.activeCompany

  const fy = currentFY()
  const [to,      setTo]      = useState(fy.to)
  const [result,  setResult]  = useState<TrialBalanceResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [hasRun,  setHasRun]  = useState(false)

  const runReport = async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const data = await fetchTrialBalance(companyId, to)
      setResult(data)
      setHasRun(true)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load Trial Balance')
    } finally {
      setLoading(false)
    }
  }

  const grouped = useMemo(
    () => result ? groupRows(result.rows) : [],
    [result]
  )

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={`${styles.pageHeader} ${styles.noPrint}`}>
        <h1 className={styles.pageTitle}>Trial Balance</h1>
        <div className={styles.headerActions}>
          <button className={styles.btnPrint} onClick={() => window.print()}>
            <Printer size={13} /> Print / PDF
          </button>
        </div>
      </div>

      {/* Filter bar — Trial Balance is "as at" a single date */}
      <div className={`${styles.filterBar} ${styles.noPrint}`}>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>As at date</label>
          <input
            type="date"
            className={styles.filterInput}
            value={to}
            onChange={e => setTo(e.target.value)}
          />
        </div>
        <button className={styles.btnRun} onClick={runReport} disabled={loading || !to}>
          {loading
            ? <><Loader2 size={13} className={styles.spin} /> Loading…</>
            : 'Run Report'
          }
        </button>
        {result && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
            {result.balanced
              ? <span className={styles.balanceOk}><CheckCircle size={14} /> Balanced</span>
              : <span className={styles.balanceWarn}><AlertTriangle size={14} /> Unbalanced — check entries</span>
            }
          </div>
        )}
      </div>

      {/* Report */}
      {loading ? (
        <FoodStreamMini />
      ) : !hasRun ? (
        <div className={styles.noData}>
          <FileBarChart2 size={36} style={{ opacity: 0.3 }} />
          <span>Set the "as at" date and click Run Report</span>
        </div>
      ) : result && (
        <div className={styles.reportDoc}>
          <div className={styles.reportMeta}>
            <div className={styles.reportCompany}>{company?.name ?? '—'}</div>
            <div className={styles.reportName}>Trial Balance</div>
            <div className={styles.reportPeriod}>As at {fmtDate(to)}</div>
          </div>

          {result.rows.length === 0 ? (
            <div className={styles.noData}>No active ledgers found.</div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Ledger</th>
                    <th>Group</th>
                    <th className={styles.right}>Debit (Dr)</th>
                    <th className={styles.right}>Credit (Cr)</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map(([groupName, groupRows]) => {
                    let gDr = 0, gCr = 0
                    groupRows.forEach(r => {
                      if (r.net > 0) gDr += r.net; else gCr -= r.net
                    })
                    return (
                      <>
                        <tr key={`g-${groupName}`} className={styles.groupHeaderRow}>
                          <td colSpan={2}>{groupName}</td>
                          <td></td>
                          <td></td>
                        </tr>
                        {groupRows.map(r => (
                          <tr key={r.ledger_id}>
                            <td style={{ paddingLeft: '1.5rem' }}>{r.ledger_name}</td>
                            <td className={styles.dim}>{r.group_name}</td>
                            <td className={`${styles.right} ${styles.drValue}`}>
                              {r.net > 0 ? fmtAmt(r.net) : ''}
                            </td>
                            <td className={`${styles.right} ${styles.crValue}`}>
                              {r.net < 0 ? fmtAmt(-r.net) : ''}
                            </td>
                          </tr>
                        ))}
                        <tr className={styles.subtotalRow}>
                          <td colSpan={2}>{groupName} — Total</td>
                          <td className={`${styles.right} ${styles.mono}`}>
                            {gDr > 0 ? fmtAmt(gDr) : ''}
                          </td>
                          <td className={`${styles.right} ${styles.mono}`}>
                            {gCr > 0 ? fmtAmt(gCr) : ''}
                          </td>
                        </tr>
                      </>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className={styles.grandTotalRow}>
                    <td colSpan={2}>
                      Grand Total&nbsp;
                      {result.balanced
                        ? <span className={styles.balanceOk}><CheckCircle size={12} /> Balanced</span>
                        : <span className={styles.balanceWarn}><AlertTriangle size={12} /> Trial Balance does not balance — check entries</span>
                      }
                    </td>
                    <td className={`${styles.right} ${styles.mono}`}>{fmtAmt(result.total_dr)}</td>
                    <td className={`${styles.right} ${styles.mono}`}>{fmtAmt(result.total_cr)}</td>
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
