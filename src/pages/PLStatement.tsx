import { useState, useEffect } from 'react'
import FoodStreamMini from '@/components/FoodStreamMini'
import { Loader2, Printer, Download, FileBarChart2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchTrialBalance,
  fetchLatestPostedFY,
  fyOptions,
  fyRange,
  currentFY,
  fmtDate,
  fmtAmt,
  type TrialBalanceLedgerRow,
} from '@/lib/reports'
import { buildCsv, downloadCsv } from '@/lib/reportCsv'
import styles from './Reports.module.css'

// ── P&L derivation helpers ────────────────────────────────────────────────────

interface PLGroup { name: string; rows: TrialBalanceLedgerRow[]; total: number }

function buildPLSide(
  tbRows: TrialBalanceLedgerRow[],
  nature: 'INCOME' | 'EXPENSE',
): PLGroup[] {
  // For INCOME ledgers, income = -net (since income ledgers have Cr balance, net < 0)
  // For EXPENSE ledgers, expense = +net (since expense ledgers have Dr balance, net > 0)
  const relevant = tbRows.filter(r => r.group_nature === nature)
  const groupMap  = new Map<string, TrialBalanceLedgerRow[]>()
  for (const r of relevant) {
    if (!groupMap.has(r.group_name)) groupMap.set(r.group_name, [])
    groupMap.get(r.group_name)!.push(r)
  }
  return [...groupMap.entries()].map(([name, rows]) => {
    const total = rows.reduce((s, r) => s + (nature === 'INCOME' ? -r.net : r.net), 0)
    return { name, rows, total }
  })
}

function exportPLCsv(
  companyName: string,
  from: string,
  to: string,
  incomeGroups: PLGroup[],
  expenseGroups: PLGroup[],
  totalIncome: number,
  totalExpense: number,
  netProfit: number,
): void {
  const rows: (string | number | boolean | null | undefined)[][] = [
    ['Profit & Loss Statement'],
    ['Company', companyName],
    ['From', from],
    ['To', to],
    [],
    ['Side', 'Group', 'Ledger', 'Amount'],
  ]

  for (const grp of expenseGroups) {
    rows.push(['Expenditure', grp.name, '', ''])
    for (const r of grp.rows) rows.push(['Expenditure', grp.name, r.ledger_name, r.net > 0 ? r.net : 0])
    rows.push(['Expenditure', grp.name, 'Group Total', grp.total])
  }

  rows.push(['Expenditure', 'Net Profit' + (netProfit < 0 ? ' / Loss' : ''), '', netProfit > 0 ? netProfit : ''])

  for (const grp of incomeGroups) {
    rows.push(['Income', grp.name, '', ''])
    for (const r of grp.rows) rows.push(['Income', grp.name, r.ledger_name, -r.net > 0 ? -r.net : 0])
    rows.push(['Income', grp.name, 'Group Total', grp.total])
  }

  rows.push(['Income', 'Net Loss', '', netProfit < 0 ? -netProfit : ''])
  rows.push([], ['Expenditure Total', '', '', totalExpense], ['Income Total', '', '', totalIncome])

  const csv = buildCsv(rows)
  const safeCompany = companyName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'Company'
  downloadCsv(`profit_and_loss_${safeCompany}_${from}_to_${to}.csv`, csv)
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PLStatement() {
  const { user } = useAuth()
  const companyId = user?.activeCompany?.id ?? ''
  const company   = user?.activeCompany

  const fy = currentFY()
  const [selectedFY, setSelectedFY] = useState<number | null>(null)
  const [from,    setFrom]    = useState(fy.from)
  const [to,      setTo]      = useState(fy.to)
  const [loading, setLoading] = useState(false)
  const [hasRun,  setHasRun]  = useState(false)

  // Default to FY of most recent posted voucher, not today's FY
  useEffect(() => {
    if (!companyId) return
    fetchLatestPostedFY(companyId).then(year => {
      setSelectedFY(year)
      const r = fyRange(year)
      setFrom(r.from)
      setTo(r.to)
    }).catch(() => { /* keep currentFY default */ })
  }, [companyId])

  // P&L derived state
  const [incomeGroups,  setIncomeGroups]  = useState<PLGroup[]>([])
  const [expenseGroups, setExpenseGroups] = useState<PLGroup[]>([])
  const [totalIncome,   setTotalIncome]   = useState(0)
  const [totalExpense,  setTotalExpense]  = useState(0)
  const [netProfit,     setNetProfit]     = useState(0)

  const runReport = async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const tb = await fetchTrialBalance(companyId, to)
      const iGroups = buildPLSide(tb.rows, 'INCOME')
      const eGroups = buildPLSide(tb.rows, 'EXPENSE')
      const tIncome  = iGroups.reduce((s, g) => s + g.total, 0)
      const tExpense = eGroups.reduce((s, g) => s + g.total, 0)
      setIncomeGroups(iGroups)
      setExpenseGroups(eGroups)
      setTotalIncome(tIncome)
      setTotalExpense(tExpense)
      setNetProfit(tIncome - tExpense)
      setHasRun(true)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load P&L Statement')
    } finally {
      setLoading(false)
    }
  }

  const isProfit = netProfit >= 0

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={`${styles.pageHeader} ${styles.noPrint}`}>
        <h1 className={styles.pageTitle}>Profit &amp; Loss Statement</h1>
        <div className={styles.headerActions}>
          <button className={styles.btnPrint} onClick={() => exportPLCsv(company?.name ?? 'Company', from, to, incomeGroups, expenseGroups, totalIncome, totalExpense, netProfit)} disabled={!hasRun || loading}>
            <Download size={13} /> CSV
          </button>
          <button className={styles.btnPrint} onClick={() => window.print()} disabled={!hasRun || loading}>
            <Printer size={13} /> Print / PDF
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className={`${styles.filterBar} ${styles.noPrint}`}>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Financial Year</label>
          <select
            className={styles.filterSelect}
            value={selectedFY ?? ''}
            onChange={e => {
              const year = Number(e.target.value)
              setSelectedFY(year)
              const r = fyRange(year)
              setFrom(r.from)
              setTo(r.to)
            }}
          >
            {fyOptions().map(opt => (
              <option key={opt.year} value={opt.year}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>From</label>
          <input
            type="date"
            className={styles.filterInput}
            value={from}
            onChange={e => { setFrom(e.target.value); setSelectedFY(null) }}
          />
        </div>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>To</label>
          <input
            type="date"
            className={styles.filterInput}
            value={to}
            onChange={e => { setTo(e.target.value); setSelectedFY(null) }}
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
          <span>Set the period and click Run Report</span>
        </div>
      ) : (
        <div className={styles.reportDoc}>
          <div className={styles.reportMeta}>
            <div className={styles.reportCompany}>{company?.name ?? '—'}</div>
            <div className={styles.reportName}>Profit &amp; Loss Statement</div>
            <div className={styles.reportPeriod}>{fmtDate(from)} — {fmtDate(to)}</div>
          </div>

          <div className={styles.twoCol}>
            {/* ── Left column: Expenditure ── */}
            <div className={styles.colSection}>
              <div className={styles.colTitle}>Expenditure</div>
              <table className={styles.colTable}>
                <tbody>
                  {expenseGroups.map(grp => (
                    <>
                      <tr key={`eg-${grp.name}`}>
                        <td colSpan={2} className={styles.colGroupHeader}>{grp.name}</td>
                      </tr>
                      {grp.rows.map(r => (
                        <tr key={r.ledger_id}>
                          <td style={{ paddingLeft: '1.5rem' }}>{r.ledger_name}</td>
                          <td className={`${styles.right} ${styles.mono}`} style={{ whiteSpace: 'nowrap' }}>
                            {fmtAmt(r.net > 0 ? r.net : 0)}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td className={styles.colGroupTotal}>{grp.name} Total</td>
                        <td className={`${styles.right} ${styles.mono} ${styles.colGroupTotal}`}>
                          {fmtAmt(Math.max(0, grp.total))}
                        </td>
                      </tr>
                    </>
                  ))}

                  {/* Net Profit goes on left (expenditure) side if income > expense */}
                  {isProfit && (
                    <tr>
                      <td className={styles.colNetProfit}>Net Profit</td>
                      <td className={`${styles.right} ${styles.mono} ${styles.colNetProfit}`}>
                        {fmtAmt(netProfit)}
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td className={styles.colGrandTotal}>Total</td>
                    <td className={`${styles.right} ${styles.mono} ${styles.colGrandTotal}`}>
                      {fmtAmt(isProfit ? totalExpense + netProfit : totalExpense)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* ── Right column: Income ── */}
            <div className={styles.colSection}>
              <div className={styles.colTitle}>Income</div>
              <table className={styles.colTable}>
                <tbody>
                  {incomeGroups.map(grp => (
                    <>
                      <tr key={`ig-${grp.name}`}>
                        <td colSpan={2} className={styles.colGroupHeader}>{grp.name}</td>
                      </tr>
                      {grp.rows.map(r => (
                        <tr key={r.ledger_id}>
                          <td style={{ paddingLeft: '1.5rem' }}>{r.ledger_name}</td>
                          <td className={`${styles.right} ${styles.mono}`} style={{ whiteSpace: 'nowrap' }}>
                            {fmtAmt(-r.net > 0 ? -r.net : 0)}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td className={styles.colGroupTotal}>{grp.name} Total</td>
                        <td className={`${styles.right} ${styles.mono} ${styles.colGroupTotal}`}>
                          {fmtAmt(Math.max(0, grp.total))}
                        </td>
                      </tr>
                    </>
                  ))}

                  {/* Net Loss goes on right (income) side if expense > income */}
                  {!isProfit && (
                    <tr>
                      <td className={styles.colNetLoss}>Net Loss</td>
                      <td className={`${styles.right} ${styles.mono} ${styles.colNetLoss}`}>
                        {fmtAmt(-netProfit)}
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td className={styles.colGrandTotal}>Total</td>
                    <td className={`${styles.right} ${styles.mono} ${styles.colGrandTotal}`}>
                      {fmtAmt(!isProfit ? totalIncome + (-netProfit) : totalIncome)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
