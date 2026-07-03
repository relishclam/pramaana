import { useState } from 'react'
import FoodStreamMini from '@/components/FoodStreamMini'
import { Loader2, Printer, FileBarChart2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchCashFlow,
  currentFY,
  fmtDate,
  fmtAmt,
  type CashFlowResult,
  type CashFlowItem,
} from '@/lib/reports'
import styles from './Reports.module.css'

// ── Section renderer ──────────────────────────────────────────────────────────

function CashFlowSection({
  title,
  items,
  total,
}: {
  title: string
  items: CashFlowItem[]
  total: number
}) {
  const isPositive = total >= 0

  return (
    <div className={styles.cfSection}>
      <div className={styles.cfSectionTitle}>{title}</div>

      {items.length === 0 ? (
        <div style={{ padding: '0.5rem 0', fontSize: '0.8125rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>
          No activity in this category for the period.
        </div>
      ) : (
        items.map((item, i) => (
          <div key={i} className={styles.cfRow}>
            <span className={styles.cfRowLabel}>{item.label}</span>
            <span className={`${styles.cfRowAmt} ${item.amount < 0 ? styles.crValue : ''}`}>
              {item.amount >= 0
                ? fmtAmt(item.amount)
                : `(${fmtAmt(-item.amount)})`
              }
            </span>
          </div>
        ))
      )}

      <div className={styles.cfTotal}>
        <span>Net {title.replace('Cash Flow from ', '')}</span>
        <span className={`${styles.cfTotalAmt} ${isPositive ? styles.drValue : styles.crValue}`}>
          {isPositive ? fmtAmt(total) : `(${fmtAmt(-total)})`}
        </span>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CashFlow() {
  const { user }  = useAuth()
  const companyId = user?.activeCompany?.id ?? ''
  const company   = user?.activeCompany

  const fy = currentFY()
  const [from,    setFrom]    = useState(fy.from)
  const [to,      setTo]      = useState(fy.to)
  const [result,  setResult]  = useState<CashFlowResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [hasRun,  setHasRun]  = useState(false)

  const runReport = async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const data = await fetchCashFlow(companyId, from, to)
      setResult(data)
      setHasRun(true)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load Cash Flow Statement')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={`${styles.pageHeader} ${styles.noPrint}`}>
        <h1 className={styles.pageTitle}>Cash Flow Statement</h1>
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
            type="date" className={styles.filterInput}
            value={from} onChange={e => setFrom(e.target.value)}
          />
        </div>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>To</label>
          <input
            type="date" className={styles.filterInput}
            value={to} onChange={e => setTo(e.target.value)}
          />
        </div>
        <button className={styles.btnRun} onClick={runReport} disabled={loading || !from || !to}>
          {loading
            ? <><Loader2 size={13} className={styles.spin} /> Loading…</>
            : 'Run Report'
          }
        </button>
        <div style={{ marginLeft: 'auto', fontSize: '0.8125rem', color: 'var(--text-muted)', alignSelf: 'center' }}>
          Indirect Method
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className={styles.loading}>
          <Loader2 size={20} className={styles.spin} /> Computing cash flows…
        </div>
      ) : !hasRun ? (
        <div className={styles.noData}>
          <FileBarChart2 size={36} style={{ opacity: 0.3 }} />
          <span>Set the period and click Run Report</span>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-dim)' }}>
            Uses the indirect method — starts from net profit and adjusts for working capital changes
          </span>
        </div>
      ) : result && (
        <div className={styles.reportDoc}>
          <div className={styles.reportMeta}>
            <div className={styles.reportCompany}>{company?.name ?? '—'}</div>
            <div className={styles.reportName}>Cash Flow Statement (Indirect Method)</div>
            <div className={styles.reportPeriod}>{fmtDate(from)} to {fmtDate(to)}</div>
          </div>

          {/* Three sections */}
          <CashFlowSection
            title={result.operating.title}
            items={result.operating.items}
            total={result.operating.total}
          />
          <CashFlowSection
            title={result.investing.title}
            items={result.investing.items}
            total={result.investing.total}
          />
          <CashFlowSection
            title={result.financing.title}
            items={result.financing.items}
            total={result.financing.total}
          />

          {/* Summary */}
          <div className={styles.cfSummary}>
            <div className={`${styles.cfSummaryRow}`}>
              <span style={{ color: 'var(--text-muted)' }}>Opening Cash &amp; Bank Balance</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                {fmtAmt(result.opening_cash)}
              </span>
            </div>
            <div className={`${styles.cfSummaryRow}`}>
              <span style={{ color: 'var(--text-muted)' }}>
                Net Increase / (Decrease) in Cash &amp; Bank
              </span>
              <span style={{
                fontFamily: 'var(--font-mono)', fontWeight: 600,
                color: result.net_change >= 0 ? 'var(--success)' : 'var(--error)',
              }}>
                {result.net_change >= 0
                  ? fmtAmt(result.net_change)
                  : `(${fmtAmt(-result.net_change)})`
                }
              </span>
            </div>
            <div className={`${styles.cfSummaryRow} ${styles.cfSummaryNet}`}>
              <span>Closing Cash &amp; Bank Balance</span>
              <span style={{
                fontFamily: 'var(--font-mono)',
                color: result.closing_cash >= 0 ? 'var(--teal)' : 'var(--error)',
              }}>
                {fmtAmt(result.closing_cash)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
