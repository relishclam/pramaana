import { useState, useEffect } from 'react'
import FoodStreamMini from '@/components/FoodStreamMini'
import { Loader2, Printer, Download, FileBarChart2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchLedgerOptions,
  fetchLedgerStatement,
  currentFY,
  fmtDate,
  fmtAmt,
  fmtBalance,
  type LedgerOption,
  type LedgerStatementResult,
} from '@/lib/reports'
import { buildCsv, downloadCsv } from '@/lib/reportCsv'
import styles from './Reports.module.css'

// ── Balance display helper ────────────────────────────────────────────────────

function BalanceCell({ net }: { net: number }) {
  if (Math.abs(net) < 0.005) return <span className={styles.dim}>Nil</span>
  return (
    <span className={net > 0 ? styles.drValue : styles.crValue}>
      {fmtBalance(net)}
    </span>
  )
}

function exportLedgerStatementCsv(
  companyName: string,
  from: string,
  to: string,
  result: LedgerStatementResult,
): void {
  const csv = buildCsv([
    ['Ledger Statement'],
    ['Company', companyName],
    ['Ledger', result.ledger_name],
    ['Group', result.group_name],
    ['From', from],
    ['To', to],
    [],
    ['Date', 'Voucher No.', 'Type', 'Party', 'Narration', 'Dr', 'Cr', 'Running Balance'],
    ['Opening Balance', '', '', '', '', '', '', result.opening_net],
    ...result.rows.map((r) => [
      r.voucher_date,
      r.voucher_number,
      r.voucher_type_name,
      r.party_name ?? '',
      r.narration ?? '',
      r.entry_type === 'Dr' ? r.amount : '',
      r.entry_type === 'Cr' ? r.amount : '',
      r.running_balance,
    ]),
    ['Closing Balance', '', '', '', '', '', '', result.closing_net],
  ])
  const safeCompany = companyName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'Company'
  const safeLedger = result.ledger_name.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'Ledger'
  downloadCsv(`ledger_statement_${safeCompany}_${safeLedger}_${from}_to_${to}.csv`, csv)
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LedgerStatement() {
  const { user } = useAuth()
  const companyId = user?.activeCompany?.id ?? ''
  const company   = user?.activeCompany

  const fy = currentFY()
  const [from,      setFrom]      = useState(fy.from)
  const [to,        setTo]        = useState(fy.to)
  const [ledgerId,  setLedgerId]  = useState('')
  const [ledgers,   setLedgers]   = useState<LedgerOption[]>([])
  const [result,    setResult]    = useState<LedgerStatementResult | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [ledLoading, setLedLoading] = useState(false)
  const [hasRun,    setHasRun]    = useState(false)

  // Load ledger options once company is known
  useEffect(() => {
    if (!companyId) return
    setLedLoading(true)
    fetchLedgerOptions(companyId)
      .then(setLedgers)
      .catch(err => toast.error(err instanceof Error ? err.message : 'Failed to load ledgers'))
      .finally(() => setLedLoading(false))
  }, [companyId])

  const runReport = async () => {
    if (!companyId || !ledgerId) return
    setLoading(true)
    try {
      const data = await fetchLedgerStatement(companyId, ledgerId, from, to)
      setResult(data)
      setHasRun(true)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load Ledger Statement')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={`${styles.pageHeader} ${styles.noPrint}`}>
        <h1 className={styles.pageTitle}>Ledger Statement</h1>
        <div className={styles.headerActions}>
          <button className={styles.btnPrint} onClick={() => result && exportLedgerStatementCsv(company?.name ?? 'Company', from, to, result)} disabled={!hasRun || loading || !result}>
            <Download size={13} /> CSV
          </button>
          <button className={styles.btnPrint} onClick={() => window.print()} disabled={!hasRun || loading}>
            <Printer size={13} /> Print / PDF
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className={`${styles.filterBar} ${styles.noPrint}`}>
        <div className={styles.filterGroup} style={{ minWidth: 240 }}>
          <label className={styles.filterLabel}>Ledger</label>
          <select
            className={styles.filterSelect}
            value={ledgerId}
            onChange={e => setLedgerId(e.target.value)}
            disabled={ledLoading}
          >
            <option value="">— Select ledger —</option>
            {ledgers.map(l => (
              <option key={l.id} value={l.id}>{l.name} ({l.group_name})</option>
            ))}
          </select>
        </div>
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
        <button
          className={styles.btnRun}
          onClick={runReport}
          disabled={loading || !ledgerId || !from || !to}
        >
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
          <span>Select a ledger, set the date range, and click Run Report</span>
        </div>
      ) : result && (
        <div className={styles.reportDoc}>
          <div className={styles.reportMeta}>
            <div className={styles.reportCompany}>{company?.name ?? '—'}</div>
            <div className={styles.reportName}>Ledger Statement — {result.ledger_name}</div>
            <div className={styles.reportPeriod}>
              {result.group_name} &nbsp;·&nbsp; {fmtDate(from)} — {fmtDate(to)}
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Voucher No.</th>
                  <th>Type</th>
                  <th>Party</th>
                  <th>Narration</th>
                  <th className={styles.right}>Dr</th>
                  <th className={styles.right}>Cr</th>
                  <th className={styles.right}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {/* Opening balance row */}
                <tr className={styles.openingRow}>
                  <td>{fmtDate(from)}</td>
                  <td colSpan={4} style={{ fontStyle: 'italic' }}>Opening Balance</td>
                  <td className={styles.right}></td>
                  <td className={styles.right}></td>
                  <td className={`${styles.right} ${styles.mono}`}>
                    <BalanceCell net={result.opening_net} />
                  </td>
                </tr>

                {result.rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className={styles.noData} style={{ padding: '1.5rem' }}>
                      No transactions in this period
                    </td>
                  </tr>
                ) : (
                  result.rows.map(r => (
                    <tr key={r.id}>
                      <td className={styles.dim}>{fmtDate(r.voucher_date)}</td>
                      <td className={styles.mono}>{r.voucher_number}</td>
                      <td className={styles.dim}>{r.voucher_type_name}</td>
                      <td>{r.party_name ?? <span className={styles.dim}>—</span>}</td>
                      <td className={styles.dim}>{r.narration ?? '—'}</td>
                      <td className={`${styles.right} ${styles.drValue}`}>
                        {r.entry_type === 'Dr' ? fmtAmt(r.amount) : ''}
                      </td>
                      <td className={`${styles.right} ${styles.crValue}`}>
                        {r.entry_type === 'Cr' ? fmtAmt(r.amount) : ''}
                      </td>
                      <td className={`${styles.right} ${styles.mono}`}>
                        <BalanceCell net={r.running_balance} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className={styles.closingRow}>
                  <td>{fmtDate(to)}</td>
                  <td colSpan={4}><strong>Closing Balance</strong></td>
                  <td className={styles.right}></td>
                  <td className={styles.right}></td>
                  <td className={`${styles.right} ${styles.mono}`}>
                    <BalanceCell net={result.closing_net} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
