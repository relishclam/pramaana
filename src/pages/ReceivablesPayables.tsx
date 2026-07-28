import { useState, useMemo, useCallback } from 'react'
import FoodStreamMini from '@/components/FoodStreamMini'
import { Loader2, Printer, Download, FileBarChart2, Search } from 'lucide-react'
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
import { fetchAllOpenBills, type BillSummary } from '@/lib/allocations'
import { buildCsv, downloadCsv } from '@/lib/reportCsv'
import styles from './Reports.module.css'

type Mode = 'both' | 'receivable' | 'payable'
type ViewMode = 'ledger' | 'bill'

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

function exportLedgerViewCsv(
  companyName: string,
  asAt: string,
  mode: Mode,
  rows: OutstandingLedger[],
): void {
  const filteredRows = rows.filter(r =>
    mode === 'both' ? true : mode === 'receivable' ? r.group_nature === 'ASSET' : r.group_nature === 'LIABILITY'
  )
  const csv = buildCsv([
    ['Receivables & Payables — Ledger View'],
    ['Company', companyName],
    ['As at', asAt],
    ['Mode', mode],
    [],
    ['Nature', 'Ledger', 'Group', 'Total Outstanding', '0-30 Days', '31-60 Days', '61-90 Days', '90+ Days'],
    ...filteredRows.map((r) => [
      r.group_nature,
      r.ledger_name,
      r.group_name,
      Math.abs(r.net_balance),
      r.aging.current,
      r.aging.b31_60,
      r.aging.b61_90,
      r.aging.b90plus,
    ]),
  ])
  const safeCompany = companyName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'Company'
  downloadCsv(`receivables_payables_ledger_${safeCompany}_${asAt}.csv`, csv)
}

function exportBillViewCsv(
  companyName: string,
  asAt: string,
  mode: Mode,
  billsByEntity: { name: string; bills: BillSummary[] }[],
): void {
  const csv = buildCsv([
    ['Receivables & Payables — Bill View'],
    ['Company', companyName],
    ['As at', asAt],
    ['Mode', mode],
    [],
    ['Party', 'Bill No.', 'Date', 'Ref / Narration', 'Bill Amount', 'Outstanding', 'Age (days)', 'Bucket'],
    ...billsByEntity.flatMap(({ name, bills }) => bills.map((b) => {
      const age = Math.floor((new Date().getTime() - new Date(b.voucher_date + 'T00:00:00').getTime()) / 86_400_000)
      const bucket = age <= 30 ? '0-30' : age <= 60 ? '31-60' : age <= 90 ? '61-90' : '90+'
      return [name, b.voucher_number, b.voucher_date, b.ref_document_number ?? b.narration ?? '', b.amount, b.outstanding, age, bucket]
    })),
  ])
  const safeCompany = companyName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'Company'
  downloadCsv(`receivables_payables_bills_${safeCompany}_${asAt}.csv`, csv)
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReceivablesPayables() {
  const { user }  = useAuth()
  const companyId = user?.activeCompany?.id ?? ''
  const company   = user?.activeCompany

  const fy = currentFY()
  const [asAt,      setAsAt]      = useState(fy.to)
  const [mode,      setMode]      = useState<Mode>('both')
  const [viewMode,  setViewMode]  = useState<ViewMode>('ledger')
  const [search,    setSearch]    = useState('')
  const [rows,      setRows]      = useState<OutstandingLedger[]>([])
  const [billRows,  setBillRows]  = useState<BillSummary[]>([])
  const [loading,   setLoading]   = useState(false)
  const [hasRun,    setHasRun]    = useState(false)

  const runReport = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      if (viewMode === 'ledger') {
        const natures: LedgerNature[] =
          mode === 'receivable' ? ['ASSET'] :
          mode === 'payable'    ? ['LIABILITY'] :
          ['ASSET', 'LIABILITY']
        const data = await fetchOutstandingLedgers(companyId, asAt, natures)
        setRows(data)
      } else {
        // Bill-by-bill mode: fetch open purchase/sales bills
        const natures: Array<'purchase' | 'sales'> =
          mode === 'receivable' ? ['sales'] :
          mode === 'payable'    ? ['purchase'] :
          ['purchase', 'sales']
        const [a, b] = await Promise.all([
          natures.includes('purchase') ? fetchAllOpenBills(companyId, 'purchase') : Promise.resolve([]),
          natures.includes('sales')    ? fetchAllOpenBills(companyId, 'sales')    : Promise.resolve([]),
        ])
        setBillRows([...a, ...b])
      }
      setHasRun(true)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load report')
    } finally {
      setLoading(false)
    }
  }, [companyId, asAt, mode, viewMode])

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

  const filteredBills = useMemo(() =>
    billRows.filter(r =>
      !search ||
      (r.entity_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      r.voucher_number.toLowerCase().includes(search.toLowerCase())
    ),
    [billRows, search]
  )

  // Group bills by entity for the bill-by-bill view
  const billsByEntity = useMemo(() => {
    const map = new Map<string, { name: string; bills: BillSummary[] }>()
    for (const b of filteredBills) {
      const key = b.entity_id ?? '__none'
      if (!map.has(key)) map.set(key, { name: b.entity_name ?? 'No party', bills: [] })
      map.get(key)!.bills.push(b)
    }
    return [...map.entries()]
      .map(([, v]) => v)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [filteredBills])

  const billAgingBucket = (isoDate: string): string => {
    const d = Math.floor((new Date().getTime() - new Date(isoDate + 'T00:00:00').getTime()) / 86_400_000)
    if (d <= 30) return '0–30'
    if (d <= 60) return '31–60'
    if (d <= 90) return '61–90'
    return '90+'
  }

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={`${styles.pageHeader} ${styles.noPrint}`}>
        <h1 className={styles.pageTitle}>Receivables &amp; Payables</h1>
        <div className={styles.headerActions}>
          <button
            className={styles.btnPrint}
            onClick={() => viewMode === 'ledger'
              ? exportLedgerViewCsv(company?.name ?? 'Company', asAt, mode, filtered)
              : exportBillViewCsv(company?.name ?? 'Company', asAt, mode, billsByEntity)
            }
            disabled={!hasRun || loading}
          >
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
        {/* View mode toggle */}
        <div className={styles.filterGroup} style={{ borderLeft: '1px solid var(--border)', paddingLeft: '0.875rem' }}>
          <label className={styles.filterLabel}>View</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['ledger', 'bill'] as ViewMode[]).map(v => (
              <button
                key={v}
                type="button"
                onClick={() => { setViewMode(v); setHasRun(false) }}
                style={{
                  padding: '0.3rem 0.75rem',
                  borderRadius: 6,
                  border: `1px solid ${viewMode === v ? 'var(--teal)' : 'var(--border)'}`,
                  background: viewMode === v ? 'var(--teal-light)' : 'transparent',
                  color: viewMode === v ? 'var(--teal)' : 'var(--text-muted)',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textTransform: 'capitalize' as const,
                }}
              >
                {v === 'ledger' ? 'Ledger' : 'Bill-by-Bill'}
              </button>
            ))}
          </div>
        </div>
        <button className={styles.btnRun} onClick={runReport} disabled={loading || !asAt}>
          {loading
            ? <><Loader2 size={13} className={styles.spin} /> Loading…</>
            : 'Run Report'
          }
        </button>
        {hasRun && (
          <div className={styles.filterGroup} style={{ marginLeft: 'auto' }}>
            <label className={styles.filterLabel}>{viewMode === 'ledger' ? 'Search ledger' : 'Search party / bill'}</label>
            <div className={styles.filterSearchWrap}>
              <Search size={13} className={styles.filterSearchIcon} />
              <input
                className={styles.filterSearch}
                placeholder={viewMode === 'ledger' ? 'Ledger or group name…' : 'Party name or voucher no…'}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <FoodStreamMini label="Fetching outstanding balances…" />
      ) : !hasRun ? (
        <div className={styles.noData}>
          <FileBarChart2 size={36} style={{ opacity: 0.3 }} />
          <span>Select date, mode &amp; view, then click Run Report</span>
        </div>

      ) : viewMode === 'bill' ? (
        /* ── Bill-by-Bill View ───────────────────────────────────────────── */
        billsByEntity.length === 0 ? (
          <div className={styles.noData}>
            <span>No outstanding bills found for the selected criteria.</span>
          </div>
        ) : (
          <div className={styles.reportDoc}>
            <div className={styles.reportMeta}>
              <div className={styles.reportCompany}>{company?.name ?? '—'}</div>
              <div className={styles.reportName}>Outstanding Bills — Bill-by-Bill</div>
              <div className={styles.reportPeriod}>As at {fmtDate(asAt)}</div>
            </div>
            <div style={{ padding: '1.5rem' }}>
              {billsByEntity.map(({ name, bills }) => {
                const entityTotal = bills.reduce((s, b) => s + b.outstanding, 0)
                return (
                  <div key={name} style={{ marginBottom: '2rem' }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '0.5rem 0.75rem',
                      background: 'var(--surface-2)',
                      borderBottom: '1px solid var(--border)',
                      fontSize: '0.6875rem', fontWeight: 700,
                      letterSpacing: '0.08em', textTransform: 'uppercase' as const,
                      color: 'var(--text-muted)',
                    }}>
                      <span>{name}</span>
                      <span style={{ color: 'var(--teal)' }}>{fmtAmt(entityTotal)} outstanding</span>
                    </div>
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>Bill No.</th>
                            <th>Date</th>
                            <th>Ref / Narration</th>
                            <th className={styles.right}>Bill Amt</th>
                            <th className={styles.right}>Outstanding</th>
                            <th className={styles.right}>Age (days)</th>
                            <th className={styles.right}>Bucket</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bills.map(b => {
                            const age = Math.floor(
                              (new Date().getTime() - new Date(b.voucher_date + 'T00:00:00').getTime()) / 86_400_000
                            )
                            const bucket = billAgingBucket(b.voucher_date)
                            return (
                              <tr key={b.id}>
                                <td style={{ fontWeight: 600 }}>{b.voucher_number}</td>
                                <td className={styles.dim}>{fmtDate(b.voucher_date)}</td>
                                <td className={styles.dim} style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {b.ref_document_number ?? b.narration ?? <span className={styles.dim}>—</span>}
                                </td>
                                <td className={styles.right}>{fmtAmt(b.amount)}</td>
                                <td className={`${styles.right} ${styles.drValue}`}>{fmtAmt(b.outstanding)}</td>
                                <td className={styles.right}>{age}</td>
                                <td className={`${styles.right} ${age > 90 ? styles.crValue : ''}`}>{bucket}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                        <tfoot>
                          <tr className={styles.grandTotalRow}>
                            <td colSpan={4}><strong>Total</strong></td>
                            <td className={`${styles.right} ${styles.drValue}`}>{fmtAmt(entityTotal)}</td>
                            <td colSpan={2} />
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )

      ) : filtered.length === 0 ? (
        /* ── Ledger View — empty state ──────────────────────────────────── */
        <div className={styles.noData}>
          <span>No outstanding balances found for the selected criteria.</span>
        </div>
      ) : (
        /* ── Ledger View ─────────────────────────────────────────────────── */
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
