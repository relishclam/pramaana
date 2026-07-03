import { useState } from 'react'
import FoodStreamMini from '@/components/FoodStreamMini'
import { Loader2, FileBarChart2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import { fetchRatioAnalysis, currentFY, fmtDate, type RatioResult } from '@/lib/reports'
import styles from './Reports.module.css'

// ── Ratio card data ────────────────────────────────────────────────────────────

interface RatioDef {
  key:     keyof RatioResult
  label:   string
  desc:    string
  format:  'x' | '%' | 'days'
  good:    'high' | 'low' | 'neutral'
  benchmark?: { good: number; warn: number }
}

const RATIOS: RatioDef[] = [
  {
    key: 'current_ratio',
    label: 'Current Ratio',
    desc: 'Current Assets ÷ Current Liabilities',
    format: 'x',
    good: 'high',
    benchmark: { good: 2, warn: 1 },
  },
  {
    key: 'quick_ratio',
    label: 'Quick Ratio',
    desc: '(Current Assets − Inventory) ÷ Current Liabilities',
    format: 'x',
    good: 'high',
    benchmark: { good: 1, warn: 0.5 },
  },
  {
    key: 'debt_to_equity',
    label: 'Debt-to-Equity',
    desc: 'Total Debt ÷ Shareholders\' Equity',
    format: 'x',
    good: 'low',
    benchmark: { good: 1, warn: 2 },
  },
  {
    key: 'net_profit_margin',
    label: 'Net Profit Margin',
    desc: 'Net Profit ÷ Revenue × 100',
    format: '%',
    good: 'high',
    benchmark: { good: 0.1, warn: 0 },
  },
  {
    key: 'return_on_assets',
    label: 'Return on Assets',
    desc: 'Net Profit ÷ Total Assets × 100',
    format: '%',
    good: 'high',
    benchmark: { good: 0.05, warn: 0 },
  },
  {
    key: 'return_on_equity',
    label: 'Return on Equity',
    desc: 'Net Profit ÷ Equity × 100',
    format: '%',
    good: 'high',
    benchmark: { good: 0.15, warn: 0 },
  },
  {
    key: 'debtors_days',
    label: 'Debtor Days',
    desc: '(Debtors ÷ Revenue) × 365',
    format: 'days',
    good: 'low',
    benchmark: { good: 30, warn: 60 },
  },
  {
    key: 'creditors_days',
    label: 'Creditor Days',
    desc: '(Creditors ÷ Expenses) × 365',
    format: 'days',
    good: 'neutral',
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatValue(val: number, fmt: RatioDef['format']): string {
  if (fmt === 'x')    return val.toFixed(2) + 'x'
  if (fmt === '%')    return (val * 100).toFixed(1) + '%'
  if (fmt === 'days') return val.toFixed(0) + ' days'
  return val.toFixed(2)
}

function ratioColor(val: number, def: RatioDef): string {
  if (def.good === 'neutral' || !def.benchmark) return 'var(--teal)'
  const { good, warn } = def.benchmark
  if (def.good === 'high') {
    if (val >= good) return 'var(--success)'
    if (val >= warn) return 'var(--gold)'
    return 'var(--error)'
  } else {
    if (val <= good) return 'var(--success)'
    if (val <= warn) return 'var(--gold)'
    return 'var(--error)'
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RatioAnalysis() {
  const { user }  = useAuth()
  const companyId = user?.activeCompany?.id ?? ''
  const company   = user?.activeCompany

  const fy = currentFY()
  const [to,      setTo]      = useState(fy.to)
  const [result,  setResult]  = useState<RatioResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [hasRun,  setHasRun]  = useState(false)

  const runReport = async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const data = await fetchRatioAnalysis(companyId, to)
      setResult(data)
      setHasRun(true)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to compute ratios')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={`${styles.pageHeader} ${styles.noPrint}`}>
        <h1 className={styles.pageTitle}>Ratio Analysis</h1>
        {hasRun && company && (
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
            {company.name} · As at {fmtDate(to)}
          </span>
        )}
      </div>

      {/* Filter bar */}
      <div className={`${styles.filterBar} ${styles.noPrint}`}>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>As at date</label>
          <input
            type="date" className={styles.filterInput}
            value={to} onChange={e => setTo(e.target.value)}
          />
        </div>
        <button className={styles.btnRun} onClick={runReport} disabled={loading || !to}>
          {loading
            ? <><Loader2 size={13} className={styles.spin} /> Computing…</>
            : <><RefreshCw size={13} /> Compute Ratios</>
          }
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className={styles.loading}>
          <Loader2 size={20} className={styles.spin} /> Computing financial ratios…
        </div>
      ) : !hasRun ? (
        <div className={styles.noData}>
          <FileBarChart2 size={36} style={{ opacity: 0.3 }} />
          <span>Set the "as at" date and click Compute Ratios</span>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-dim)' }}>
            Liquidity · Profitability · Efficiency ratios derived from Trial Balance
          </span>
        </div>
      ) : result && (
        <div className={styles.reportDoc}>
          <div className={styles.reportMeta}>
            <div className={styles.reportCompany}>{company?.name ?? '—'}</div>
            <div className={styles.reportName}>Financial Ratio Analysis</div>
            <div className={styles.reportPeriod}>As at {fmtDate(to)}</div>
          </div>

          {/* Category headers + ratio cards */}
          <div>
            {/* Liquidity */}
            <div className={styles.cfSectionTitle} style={{ padding: '0.625rem 1.5rem' }}>
              Liquidity Ratios
            </div>
            <div className={styles.ratioGrid}>
              {RATIOS.filter(r => ['current_ratio', 'quick_ratio'].includes(r.key)).map(def => {
                const val = result[def.key]
                return (
                  <div key={def.key} className={styles.ratioCard}>
                    <div className={styles.ratioLabel}>{def.label}</div>
                    {val === null ? (
                      <div className={styles.ratioValueNull}>N/A</div>
                    ) : (
                      <div className={styles.ratioValue} style={{ color: ratioColor(val, def) }}>
                        {formatValue(val, def.format)}
                      </div>
                    )}
                    <div className={styles.ratioDesc}>{def.desc}</div>
                  </div>
                )
              })}
            </div>

            {/* Leverage */}
            <div className={styles.cfSectionTitle} style={{ padding: '0.625rem 1.5rem' }}>
              Leverage Ratios
            </div>
            <div className={styles.ratioGrid}>
              {RATIOS.filter(r => ['debt_to_equity'].includes(r.key)).map(def => {
                const val = result[def.key]
                return (
                  <div key={def.key} className={styles.ratioCard}>
                    <div className={styles.ratioLabel}>{def.label}</div>
                    {val === null ? (
                      <div className={styles.ratioValueNull}>N/A</div>
                    ) : (
                      <div className={styles.ratioValue} style={{ color: ratioColor(val, def) }}>
                        {formatValue(val, def.format)}
                      </div>
                    )}
                    <div className={styles.ratioDesc}>{def.desc}</div>
                  </div>
                )
              })}
            </div>

            {/* Profitability */}
            <div className={styles.cfSectionTitle} style={{ padding: '0.625rem 1.5rem' }}>
              Profitability Ratios
            </div>
            <div className={styles.ratioGrid}>
              {RATIOS.filter(r => ['net_profit_margin', 'return_on_assets', 'return_on_equity'].includes(r.key)).map(def => {
                const val = result[def.key]
                return (
                  <div key={def.key} className={styles.ratioCard}>
                    <div className={styles.ratioLabel}>{def.label}</div>
                    {val === null ? (
                      <div className={styles.ratioValueNull}>N/A</div>
                    ) : (
                      <div className={styles.ratioValue} style={{ color: ratioColor(val, def) }}>
                        {formatValue(val, def.format)}
                      </div>
                    )}
                    <div className={styles.ratioDesc}>{def.desc}</div>
                  </div>
                )
              })}
            </div>

            {/* Efficiency */}
            <div className={styles.cfSectionTitle} style={{ padding: '0.625rem 1.5rem' }}>
              Efficiency Ratios
            </div>
            <div className={styles.ratioGrid}>
              {RATIOS.filter(r => ['debtors_days', 'creditors_days'].includes(r.key)).map(def => {
                const val = result[def.key]
                return (
                  <div key={def.key} className={styles.ratioCard}>
                    <div className={styles.ratioLabel}>{def.label}</div>
                    {val === null ? (
                      <div className={styles.ratioValueNull}>N/A</div>
                    ) : (
                      <div className={styles.ratioValue} style={{ color: ratioColor(val as number, def) }}>
                        {formatValue(val as number, def.format)}
                      </div>
                    )}
                    <div className={styles.ratioDesc}>{def.desc}</div>
                  </div>
                )
              })}
            </div>

            {/* Note */}
            <div style={{ padding: '1rem 1.5rem', fontSize: '0.8125rem', color: 'var(--text-dim)', borderTop: '1px solid var(--border)' }}>
              <strong style={{ color: 'var(--text-muted)' }}>Note:</strong> Ratios are derived by classifying ledger groups
              by name patterns (e.g. "Fixed Assets", "Loan", "Capital"). For best accuracy, ensure ledger group names
              follow standard terminology. N/A indicates the denominator is zero or the ledger type was not detected.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
