import { useState } from 'react'
import FoodStreamMini from '@/components/FoodStreamMini'
import { Loader2, Printer, Download, FileBarChart2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchTrialBalance,
  currentFY,
  fmtDate,
  fmtAmt,
  type TrialBalanceLedgerRow,
} from '@/lib/reports'
import { buildCsv, downloadCsv } from '@/lib/reportCsv'
import styles from './Reports.module.css'

// ── Balance sheet derivation helpers ─────────────────────────────────────────

interface BSGroup {
  name: string
  nature: 'ASSET' | 'LIABILITY'
  rows: TrialBalanceLedgerRow[]
  total: number
}

function signedBalanceAmount(net: number, nature: 'ASSET' | 'LIABILITY'): number {
  return nature === 'LIABILITY' ? -net : net
}

function fmtSignedAmount(amount: number): string {
  return amount < 0 ? `-${fmtAmt(Math.abs(amount))}` : fmtAmt(amount)
}

function buildBSSide(
  tbRows: TrialBalanceLedgerRow[],
  nature: 'ASSET' | 'LIABILITY',
): BSGroup[] {
  // ASSET  ledgers normally have Dr closing balance → net > 0 → show on right (Assets)
  // LIABILITY ledgers normally have Cr closing balance → net < 0 → show on left (Liabilities)
  const relevant = tbRows.filter(r => r.group_nature === nature)
  const groupMap  = new Map<string, TrialBalanceLedgerRow[]>()
  for (const r of relevant) {
    if (!groupMap.has(r.group_name)) groupMap.set(r.group_name, [])
    groupMap.get(r.group_name)!.push(r)
  }
  return [...groupMap.entries()].map(([name, rows]) => {
    const total = rows.reduce((s, r) => s + signedBalanceAmount(r.net, nature), 0)
    return { name, nature, rows, total }
  })
}

function exportBalanceSheetCsv(
  companyName: string,
  to: string,
  assetGroups: BSGroup[],
  liabilityGroups: BSGroup[],
  totalAssets: number,
  totalLiabilities: number,
  netProfit: number,
): void {
  const rows: (string | number | boolean | null | undefined)[][] = [
    ['Balance Sheet'],
    ['Company', companyName],
    ['As at', to],
    [],
    ['Side', 'Group', 'Ledger', 'Amount'],
  ]

  for (const grp of liabilityGroups) {
    rows.push(['Liabilities & Capital', grp.name, '', ''])
    for (const r of grp.rows) rows.push(['Liabilities & Capital', grp.name, r.ledger_name, signedBalanceAmount(r.net, grp.nature)])
    rows.push(['Liabilities & Capital', grp.name, 'Group Total', grp.total])
  }
  rows.push(['Liabilities & Capital', netProfit >= 0 ? 'Add: Net Profit' : 'Less: Net Loss', '', netProfit])
  rows.push(['Liabilities & Capital', 'Total', '', totalLiabilities])

  for (const grp of assetGroups) {
    rows.push(['Assets', grp.name, '', ''])
    for (const r of grp.rows) rows.push(['Assets', grp.name, r.ledger_name, signedBalanceAmount(r.net, grp.nature)])
    rows.push(['Assets', grp.name, 'Group Total', grp.total])
  }
  rows.push(['Assets', 'Total', '', totalAssets])

  const csv = buildCsv(rows)
  const safeCompany = companyName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'Company'
  downloadCsv(`balance_sheet_${safeCompany}_${to}.csv`, csv)
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BalanceSheet() {
  const { user } = useAuth()
  const companyId = user?.activeCompany?.id ?? ''
  const company   = user?.activeCompany

  const fy = currentFY()
  const [to,      setTo]      = useState(fy.to)
  const [loading, setLoading] = useState(false)
  const [hasRun,  setHasRun]  = useState(false)

  // Derived state
  const [assetGroups,     setAssetGroups]     = useState<BSGroup[]>([])
  const [liabilityGroups, setLiabilityGroups] = useState<BSGroup[]>([])
  const [totalAssets,     setTotalAssets]     = useState(0)
  const [totalLiabilities, setTotalLiabilities] = useState(0)
  const [netProfit,       setNetProfit]       = useState(0)
  const [balanced,        setBalanced]        = useState(true)

  const runReport = async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const tb = await fetchTrialBalance(companyId, to)

      // Derive Net Profit from INCOME − EXPENSE
      const totalIncome  = tb.rows.filter(r => r.group_nature === 'INCOME')
        .reduce((s, r) => s + (-r.net), 0)
      const totalExpense = tb.rows.filter(r => r.group_nature === 'EXPENSE')
        .reduce((s, r) => s + r.net, 0)
      const np = totalIncome - totalExpense

      const aGroups = buildBSSide(tb.rows, 'ASSET')
      const lGroups = buildBSSide(tb.rows, 'LIABILITY')
      const tAssets      = aGroups.reduce((s, g) => s + g.total, 0)
      const tLiabilities = lGroups.reduce((s, g) => s + g.total, 0) + np

      setAssetGroups(aGroups)
      setLiabilityGroups(lGroups)
      setTotalAssets(tAssets)
      setTotalLiabilities(tLiabilities)
      setNetProfit(np)
      setBalanced(Math.abs(tAssets - tLiabilities) < 0.01)
      setHasRun(true)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load Balance Sheet')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={`${styles.pageHeader} ${styles.noPrint}`}>
        <h1 className={styles.pageTitle}>Balance Sheet</h1>
        <div className={styles.headerActions}>
          <button className={styles.btnPrint} onClick={() => exportBalanceSheetCsv(company?.name ?? 'Company', to, assetGroups, liabilityGroups, totalAssets, totalLiabilities, netProfit)} disabled={!hasRun || loading}>
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
        {hasRun && !balanced && (
          <span className={styles.balanceWarn} style={{ marginLeft: 'auto' }}>
            ⚠ Balance Sheet does not balance — check entries
          </span>
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
      ) : (
        <div className={styles.reportDoc}>
          <div className={styles.reportMeta}>
            <div className={styles.reportCompany}>{company?.name ?? '—'}</div>
            <div className={styles.reportName}>Balance Sheet</div>
            <div className={styles.reportPeriod}>As at {fmtDate(to)}</div>
          </div>

          <div className={styles.twoCol}>
            {/* ── Left column: Liabilities & Capital ── */}
            <div className={styles.colSection}>
              <div className={styles.colTitle}>Liabilities &amp; Capital</div>
              <table className={styles.colTable}>
                <tbody>
                  {liabilityGroups.map(grp => (
                    <>
                      <tr key={`lg-${grp.name}`}>
                        <td colSpan={2} className={styles.colGroupHeader}>{grp.name}</td>
                      </tr>
                      {grp.rows.map(r => (
                        <tr key={r.ledger_id}>
                          <td style={{ paddingLeft: '1.5rem' }}>{r.ledger_name}</td>
                          <td className={`${styles.right} ${styles.mono}`} style={{ whiteSpace: 'nowrap' }}>
                            {fmtSignedAmount(signedBalanceAmount(r.net, grp.nature))}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td className={styles.colGroupTotal}>{grp.name} Total</td>
                        <td className={`${styles.right} ${styles.mono} ${styles.colGroupTotal}`}>
                          {fmtSignedAmount(grp.total)}
                        </td>
                      </tr>
                    </>
                  ))}

                  {/* Net Profit / Loss added to Capital */}
                  <tr>
                    <td className={netProfit >= 0 ? styles.colNetProfit : styles.colNetLoss}>
                      {netProfit >= 0 ? 'Add: Net Profit' : 'Less: Net Loss'}
                    </td>
                    <td className={`${styles.right} ${styles.mono} ${netProfit >= 0 ? styles.colNetProfit : styles.colNetLoss}`}>
                      {fmtSignedAmount(netProfit)}
                    </td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td className={styles.colGrandTotal}>Total</td>
                    <td className={`${styles.right} ${styles.mono} ${styles.colGrandTotal}`}>
                      {fmtSignedAmount(totalLiabilities)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* ── Right column: Assets ── */}
            <div className={styles.colSection}>
              <div className={styles.colTitle}>Assets</div>
              <table className={styles.colTable}>
                <tbody>
                  {assetGroups.map(grp => (
                    <>
                      <tr key={`ag-${grp.name}`}>
                        <td colSpan={2} className={styles.colGroupHeader}>{grp.name}</td>
                      </tr>
                      {grp.rows.map(r => (
                        <tr key={r.ledger_id}>
                          <td style={{ paddingLeft: '1.5rem' }}>{r.ledger_name}</td>
                          <td className={`${styles.right} ${styles.mono}`} style={{ whiteSpace: 'nowrap' }}>
                            {fmtSignedAmount(signedBalanceAmount(r.net, grp.nature))}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td className={styles.colGroupTotal}>{grp.name} Total</td>
                        <td className={`${styles.right} ${styles.mono} ${styles.colGroupTotal}`}>
                          {fmtSignedAmount(grp.total)}
                        </td>
                      </tr>
                    </>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className={styles.colGrandTotal}>Total</td>
                    <td className={`${styles.right} ${styles.mono} ${styles.colGrandTotal}`}>
                      {fmtSignedAmount(totalAssets)}
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
