import { useState } from 'react'
import FoodStreamMini from '@/components/FoodStreamMini'
import { Loader2, Download, FileBarChart2, AlertTriangle, Clock, Calendar, Hash, TrendingUp, Printer } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchExceptionReport,
  currentFY,
  fmtDate,
  fmtAmt,
  type ExceptionVoucher,
  type ExceptionReport,
} from '@/lib/reports'
import { buildCsv, downloadCsv } from '@/lib/reportCsv'
import styles from './Reports.module.css'

type Section = 'stale_pending' | 'backdated' | 'round_figures' | 'no_narration' | 'high_value'

const SECTIONS: { key: Section; label: string; icon: React.ReactNode; desc: string }[] = [
  {
    key:   'stale_pending',
    label: 'Stale Pending Approvals',
    icon:  <Clock size={14} />,
    desc:  'Vouchers in pending_approval status for more than 7 days',
  },
  {
    key:   'backdated',
    label: 'Backdated Entries',
    icon:  <Calendar size={14} />,
    desc:  'Voucher date is more than 7 days before the entry was created',
  },
  {
    key:   'round_figures',
    label: 'Large Round Figures',
    icon:  <Hash size={14} />,
    desc:  'Posted vouchers ≥ ₹1,00,000 with amounts divisible by ₹10,000',
  },
  {
    key:   'no_narration',
    label: 'Missing Narration',
    icon:  <AlertTriangle size={14} />,
    desc:  'Posted vouchers ≥ ₹50,000 with no narration',
  },
  {
    key:   'high_value',
    label: 'Unusually High Amounts',
    icon:  <TrendingUp size={14} />,
    desc:  'Posted amounts > 2 standard deviations above mean (and > 3× mean)',
  },
]

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  draft:            { bg: 'var(--surface-2)',     color: 'var(--text-muted)' },
  pending_approval: { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b'          },
  posted:           { bg: 'rgba(34,197,94,0.12)',  color: '#22c55e'          },
  cancelled:        { bg: 'rgba(239,68,68,0.08)',  color: '#ef4444'          },
}

function exportExceptionCsv(companyName: string, from: string, to: string, tab: Section, rows: ExceptionVoucher[]): void {
  const csv = buildCsv([
    ['Exception Report'],
    ['Company', companyName],
    ['From', from],
    ['To', to],
    ['Category', SECTIONS.find(s => s.key === tab)?.label ?? tab],
    [],
    ['#', 'Voucher No.', 'Date', 'Type', 'Party', 'Amount', 'Status', 'Flag Reason'],
    ...rows.map((r, idx) => [idx + 1, r.voucher_number, r.voucher_date, r.voucher_type, r.party_name ?? '', r.amount, r.status, r.reason]),
  ])
  const safeCompany = companyName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'Company'
  downloadCsv(`exceptions_${tab}_${safeCompany}_${from}_to_${to}.csv`, csv)
}

// ── Exception table ───────────────────────────────────────────────────────────

function ExceptionTable({ rows, section }: { rows: ExceptionVoucher[]; section: Section }) {
  if (rows.length === 0) {
    return (
      <div style={{
        padding: '2rem', textAlign: 'center',
        color: 'var(--success)', fontSize: '0.875rem',
      }}>
        ✓ No exceptions found in this category.
      </div>
    )
  }

  const isCritical = section === 'backdated' || section === 'stale_pending'

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>#</th>
            <th>Voucher No.</th>
            <th>Date</th>
            <th>Type</th>
            <th>Party</th>
            <th className={styles.right}>Amount</th>
            <th>Status</th>
            <th>Flag Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            const st = STATUS_STYLE[r.status] ?? STATUS_STYLE.draft
            return (
              <tr key={r.id}>
                <td className={styles.dim} style={{ fontSize: '0.75rem' }}>{idx + 1}</td>
                <td>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: '0.8125rem',
                    fontWeight: 600, color: 'var(--gold)',
                  }}>
                    {r.voucher_number}
                  </span>
                </td>
                <td className={styles.dim} style={{ whiteSpace: 'nowrap', fontSize: '0.8125rem' }}>
                  {fmtDate(r.voucher_date)}
                </td>
                <td className={styles.dim} style={{ fontSize: '0.8125rem' }}>{r.voucher_type}</td>
                <td style={{ maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.party_name ?? <span className={styles.dim}>—</span>}
                </td>
                <td className={`${styles.right} ${styles.mono}`}>{fmtAmt(r.amount)}</td>
                <td>
                  <span style={{
                    display: 'inline-block', padding: '0.125rem 0.5rem',
                    borderRadius: '20px', fontSize: '0.75rem', fontWeight: 600,
                    background: st.bg, color: st.color,
                  }}>
                    {r.status === 'pending_approval' ? 'Pending' :
                     r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                  </span>
                </td>
                <td>
                  <span className={isCritical ? styles.exBadgeErr : styles.exBadgeWarn}>
                    {r.reason}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className={styles.grandTotalRow}>
            <td colSpan={5}><strong>{rows.length} exception{rows.length !== 1 ? 's' : ''}</strong></td>
            <td className={`${styles.right} ${styles.drValue}`}>
              {fmtAmt(rows.reduce((s, r) => s + r.amount, 0))}
            </td>
            <td colSpan={2}></td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ExceptionReports() {
  const { user }  = useAuth()
  const companyId = user?.activeCompany?.id ?? ''
  const company   = user?.activeCompany

  const fy = currentFY()
  const [from,    setFrom]    = useState(fy.from)
  const [to,      setTo]      = useState(fy.to)
  const [tab,     setTab]     = useState<Section>('stale_pending')
  const [result,  setResult]  = useState<ExceptionReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [hasRun,  setHasRun]  = useState(false)

  const runReport = async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const data = await fetchExceptionReport(companyId, from, to)
      setResult(data)
      setHasRun(true)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load exception report')
    } finally {
      setLoading(false)
    }
  }

  const totalExceptions = result
    ? Object.values(result).reduce((s, arr) => s + arr.length, 0)
    : 0

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={`${styles.pageHeader} ${styles.noPrint}`}>
        <h1 className={styles.pageTitle}>Exception Reports</h1>
        {hasRun && (
          <span style={{
            fontSize: '0.8125rem', color: totalExceptions > 0 ? '#f59e0b' : 'var(--success)',
            fontWeight: 600,
          }}>
            {totalExceptions > 0 ? `${totalExceptions} exception${totalExceptions !== 1 ? 's' : ''} flagged` : 'No exceptions found'}
          </span>
        )}
        <div className={styles.headerActions}>
          {hasRun && result && (
            <button className={styles.btnPrint} onClick={() => exportExceptionCsv(company?.name ?? 'Company', from, to, tab, result[tab])}>
              <Download size={13} /> CSV
            </button>
          )}
          {hasRun && (
            <button className={styles.btnPrint} onClick={() => window.print()}>
              <Printer size={13} /> Print / PDF
            </button>
          )}
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
            ? <><Loader2 size={13} className={styles.spin} /> Scanning…</>
            : 'Run Scan'
          }
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <FoodStreamMini label="Scanning vouchers for anomalies…" />
      ) : !hasRun ? (
        <div className={styles.noData}>
          <AlertTriangle size={36} style={{ opacity: 0.3 }} />
          <span>Set the date range and click Run Scan</span>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-dim)' }}>
            Detects stale approvals · backdated entries · round figures · missing narration · unusually high amounts
          </span>
        </div>
      ) : result && (
        <div className={styles.reportDoc}>
          <div className={styles.reportMeta}>
            <div className={styles.reportCompany}>{company?.name ?? '—'}</div>
            <div className={styles.reportName}>Exception Report — Anomaly Detection</div>
            <div className={styles.reportPeriod}>{fmtDate(from)} to {fmtDate(to)}</div>
          </div>

          {/* Section tabs */}
          <div className={`${styles.tabNav} ${styles.noPrint}`} style={{ borderBottom: '1px solid var(--border)' }}>
            {SECTIONS.map(s => {
              const count = result[s.key].length
              return (
                <button
                  key={s.key}
                  className={`${styles.tabBtn} ${tab === s.key ? styles.tabBtnActive : ''}`}
                  onClick={() => setTab(s.key)}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    {s.icon} {s.label}
                  </span>
                  {count > 0 && (
                    <span className={styles.countBadge}>{count}</span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Active section description */}
          <div style={{
            padding: '0.625rem 1.5rem',
            fontSize: '0.8125rem',
            color: 'var(--text-muted)',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            {SECTIONS.find(s => s.key === tab)?.desc}
          </div>

          {/* Table for active tab */}
          <ExceptionTable rows={result[tab]} section={tab} />
        </div>
      )}
    </div>
  )
}
