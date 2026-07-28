import { useState, useMemo } from 'react'
import FoodStreamMini from '@/components/FoodStreamMini'
import { Loader2, Printer, Download, FileBarChart2, Info } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import { fetchGSTVouchers, currentFY, fmtDate, fmtAmt, type GSTVoucherRow } from '@/lib/reports'
import { buildCsv, downloadCsv } from '@/lib/reportCsv'
import styles from './Reports.module.css'

type Tab = 'gstr1' | 'gstr3b'

function exportGstCsv(
  companyName: string,
  from: string,
  to: string,
  tab: Tab,
  salesRows: GSTVoucherRow[],
  purchaseRows: GSTVoucherRow[],
): void {
  const rows: (string | number | boolean | null | undefined)[][] = [
    ['GST Reports'],
    ['Company', companyName],
    ['From', from],
    ['To', to],
    ['Report', tab === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'],
    [],
  ]

  if (tab === 'gstr1') {
    rows.push(['Sr.', 'Invoice No.', 'Invoice Date', 'Party', 'Invoice Value', 'Taxable Value', 'IGST', 'CGST', 'SGST'])
    salesRows.forEach((r, i) => rows.push([
      i + 1,
      r.voucher_number,
      r.voucher_date,
      r.party_name ?? '',
      r.amount,
      r.taxable_value ?? '',
      r.igst ?? '',
      r.cgst ?? '',
      r.sgst ?? '',
    ]))
  } else {
    const totalSales         = salesRows.reduce((s, r) => s + r.amount, 0)
    const totalSalesTaxable  = salesRows.reduce((s, r) => s + (r.taxable_value ?? r.amount), 0)
    const totalSalesCGST     = salesRows.reduce((s, r) => s + (r.cgst ?? 0), 0)
    const totalSalesSGST     = salesRows.reduce((s, r) => s + (r.sgst ?? 0), 0)
    const totalSalesIGST     = salesRows.reduce((s, r) => s + (r.igst ?? 0), 0)
    const totalPurchase      = purchaseRows.reduce((s, r) => s + r.amount, 0)
    const totalPurchaseTax   = purchaseRows.reduce((s, r) => s + (r.taxable_value ?? r.amount), 0)
    const totalPurchaseCGST  = purchaseRows.reduce((s, r) => s + (r.cgst ?? 0), 0)
    const totalPurchaseSGST  = purchaseRows.reduce((s, r) => s + (r.sgst ?? 0), 0)
    const totalPurchaseIGST  = purchaseRows.reduce((s, r) => s + (r.igst ?? 0), 0)
    const netOutputTax       = totalSalesCGST + totalSalesSGST + totalSalesIGST
    const netITC             = totalPurchaseCGST + totalPurchaseSGST + totalPurchaseIGST
    const netTaxLiability    = netOutputTax - netITC

    rows.push(['Section', 'Description', 'Taxable Value', 'IGST', 'CGST', 'SGST'])
    rows.push(['3.1', 'Outward taxable supplies', totalSalesTaxable, totalSalesIGST, totalSalesCGST, totalSalesSGST])
    rows.push(['4', 'ITC Available', totalPurchaseTax, totalPurchaseIGST, totalPurchaseCGST, totalPurchaseSGST])
    rows.push(['Summary', 'Output Tax', totalSales, totalSalesIGST, totalSalesCGST, totalSalesSGST])
    rows.push(['Summary', 'ITC Available', totalPurchase, totalPurchaseIGST, totalPurchaseCGST, totalPurchaseSGST])
    rows.push(['Summary', 'Net Tax Liability', Math.abs(netTaxLiability), '', '', ''])
  }

  const csv = buildCsv(rows)
  const safeCompany = companyName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'Company'
  downloadCsv(`gst_${tab}_${safeCompany}_${from}_to_${to}.csv`, csv)
}

// ── GSTR-1 Table ──────────────────────────────────────────────────────────────

function GSTR1Table({
  rows, company, from, to,
}: {
  rows: GSTVoucherRow[]
  company: { name: string } | null
  from: string
  to: string
}) {
  const total          = rows.reduce((s, r) => s + r.amount, 0)
  const totalTaxable   = rows.reduce((s, r) => s + (r.taxable_value ?? 0), 0)
  const totalCGST      = rows.reduce((s, r) => s + (r.cgst ?? 0), 0)
  const totalSGST      = rows.reduce((s, r) => s + (r.sgst ?? 0), 0)
  const totalIGST      = rows.reduce((s, r) => s + (r.igst ?? 0), 0)
  const hasBreakup     = rows.some(r => r.taxable_value !== null)

  return (
    <div className={styles.reportDoc}>
      <div className={styles.reportMeta}>
        <div className={styles.reportCompany}>{company?.name ?? '—'}</div>
        <div className={styles.reportName}>GSTR-1 — Outward Supplies Register</div>
        <div className={styles.reportPeriod}>{fmtDate(from)} to {fmtDate(to)}</div>
      </div>

      {!hasBreakup && (
        <div className={styles.gstNote}>
          <Info size={13} style={{ display: 'inline', marginRight: '0.375rem' }} />
          CGST/SGST/IGST breakup requires GST-tagged ledgers. In Pramaana, go to{' '}
          <strong>Ledgers</strong> → edit each Output GST ledger → enable{' '}
          <strong>GST / Tax Ledger</strong> and set the tax type.
        </div>
      )}

      {/* Summary cards */}
      <div className={styles.gstSummaryBox}>
        <div className={styles.gstSummaryCard}>
          <div className={styles.gstSummaryLabel}>Total Invoices</div>
          <div className={styles.gstSummaryValue}>{rows.length}</div>
        </div>
        <div className={styles.gstSummaryCard}>
          <div className={styles.gstSummaryLabel}>Total Invoice Value</div>
          <div className={styles.gstSummaryValue}>{fmtAmt(total)}</div>
        </div>
        {hasBreakup && (
          <>
            <div className={styles.gstSummaryCard}>
              <div className={styles.gstSummaryLabel}>Taxable Value</div>
              <div className={styles.gstSummaryValue}>{fmtAmt(totalTaxable)}</div>
            </div>
            <div className={styles.gstSummaryCard}>
              <div className={styles.gstSummaryLabel}>Total Tax</div>
              <div className={styles.gstSummaryValue}>{fmtAmt(totalCGST + totalSGST + totalIGST)}</div>
            </div>
          </>
        )}
        <div className={styles.gstSummaryCard}>
          <div className={styles.gstSummaryLabel}>Unique Recipients</div>
          <div className={styles.gstSummaryValue}>
            {new Set(rows.map(r => r.party_name ?? '__blank__')).size}
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className={styles.noData}>No posted sales vouchers found for this period.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Sr.</th>
                <th>Invoice No.</th>
                <th>Invoice Date</th>
                <th>Recipient / Party</th>
                <th className={styles.right}>Invoice Value</th>
                <th className={styles.right}>Taxable Value</th>
                <th className={styles.right}>IGST</th>
                <th className={styles.right}>CGST</th>
                <th className={styles.right}>SGST</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id}>
                  <td className={styles.dim} style={{ fontSize: '0.75rem' }}>{i + 1}</td>
                  <td>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: '0.8125rem',
                      fontWeight: 600, color: 'var(--gold)',
                    }}>
                      {r.voucher_number}
                    </span>
                  </td>
                  <td className={styles.dim} style={{ whiteSpace: 'nowrap' }}>
                    {fmtDate(r.voucher_date)}
                  </td>
                  <td>{r.party_name ?? <span className={styles.dim}>—</span>}</td>
                  <td className={`${styles.right} ${styles.mono}`}>{fmtAmt(r.amount)}</td>
                  <td className={r.taxable_value !== null ? `${styles.right} ${styles.mono}` : `${styles.right} ${styles.dim}`}>
                    {r.taxable_value !== null ? fmtAmt(r.taxable_value) : '—'}
                  </td>
                  <td className={r.igst !== null ? `${styles.right} ${styles.mono}` : `${styles.right} ${styles.dim}`}>
                    {r.igst !== null ? fmtAmt(r.igst) : '—'}
                  </td>
                  <td className={r.cgst !== null ? `${styles.right} ${styles.mono}` : `${styles.right} ${styles.dim}`}>
                    {r.cgst !== null ? fmtAmt(r.cgst) : '—'}
                  </td>
                  <td className={r.sgst !== null ? `${styles.right} ${styles.mono}` : `${styles.right} ${styles.dim}`}>
                    {r.sgst !== null ? fmtAmt(r.sgst) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className={styles.grandTotalRow}>
                <td colSpan={4}><strong>Total</strong></td>
                <td className={`${styles.right} ${styles.drValue}`}>{fmtAmt(total)}</td>
                <td className={`${styles.right} ${hasBreakup ? styles.drValue : styles.dim}`}>
                  {hasBreakup ? fmtAmt(totalTaxable) : '—'}
                </td>
                <td className={`${styles.right} ${hasBreakup ? styles.drValue : styles.dim}`}>
                  {hasBreakup ? fmtAmt(totalIGST) : '—'}
                </td>
                <td className={`${styles.right} ${hasBreakup ? styles.drValue : styles.dim}`}>
                  {hasBreakup ? fmtAmt(totalCGST) : '—'}
                </td>
                <td className={`${styles.right} ${hasBreakup ? styles.drValue : styles.dim}`}>
                  {hasBreakup ? fmtAmt(totalSGST) : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

// ── GSTR-3B Summary ────────────────────────────────────────────────────────────

function GSTR3BTable({
  salesRows, purchaseRows, company, from, to,
}: {
  salesRows: GSTVoucherRow[]
  purchaseRows: GSTVoucherRow[]
  company: { name: string; gstin?: string | null } | null
  from: string
  to: string
}) {
  const totalSales         = salesRows.reduce((s, r) => s + r.amount, 0)
  const totalSalesTaxable  = salesRows.reduce((s, r) => s + (r.taxable_value ?? r.amount), 0)
  const totalSalesCGST     = salesRows.reduce((s, r) => s + (r.cgst ?? 0), 0)
  const totalSalesSGST     = salesRows.reduce((s, r) => s + (r.sgst ?? 0), 0)
  const totalSalesIGST     = salesRows.reduce((s, r) => s + (r.igst ?? 0), 0)
  const hasOutputBreakup   = salesRows.some(r => r.taxable_value !== null)

  const totalPurchase          = purchaseRows.reduce((s, r) => s + r.amount, 0)
  const totalPurchaseTaxable   = purchaseRows.reduce((s, r) => s + (r.taxable_value ?? r.amount), 0)
  const totalPurchaseCGST      = purchaseRows.reduce((s, r) => s + (r.cgst ?? 0), 0)
  const totalPurchaseSGST      = purchaseRows.reduce((s, r) => s + (r.sgst ?? 0), 0)
  const totalPurchaseIGST      = purchaseRows.reduce((s, r) => s + (r.igst ?? 0), 0)
  const hasInputBreakup        = purchaseRows.some(r => r.taxable_value !== null)

  const netOutputTax   = totalSalesCGST + totalSalesSGST + totalSalesIGST
  const netITC         = totalPurchaseCGST + totalPurchaseSGST + totalPurchaseIGST
  const netTaxLiability = netOutputTax - netITC

  type RowProps = { label: string; value: string | number; igst?: number; cgst?: number; sgst?: number; bold?: boolean; indent?: boolean }
  const Row = ({ label, value, igst, cgst, sgst, bold, indent }: RowProps) => (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{
        padding: '0.5rem 0.75rem',
        paddingLeft: indent ? '2rem' : '0.75rem',
        fontWeight: bold ? 600 : undefined,
        color: 'var(--text)',
        fontSize: '0.875rem',
      }}>
        {label}
      </td>
      <td style={{
        padding: '0.5rem 0.75rem', textAlign: 'right',
        fontFamily: 'var(--font-mono)', fontSize: '0.8125rem',
        fontWeight: bold ? 600 : undefined,
        color: bold ? 'var(--text)' : 'var(--text-muted)',
      }}>
        {typeof value === 'number' ? fmtAmt(value) : value}
      </td>
      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', color: igst != null ? 'var(--text-muted)' : 'var(--text-dim)' }}>
        {igst != null ? fmtAmt(igst) : '—'}
      </td>
      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', color: cgst != null ? 'var(--text-muted)' : 'var(--text-dim)' }}>
        {cgst != null ? fmtAmt(cgst) : '—'}
      </td>
      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', color: sgst != null ? 'var(--text-muted)' : 'var(--text-dim)' }}>
        {sgst != null ? fmtAmt(sgst) : '—'}
      </td>
    </tr>
  )

  return (
    <div className={styles.reportDoc}>
      <div className={styles.reportMeta}>
        <div className={styles.reportCompany}>{company?.name ?? '—'}</div>
        <div className={styles.reportName}>GSTR-3B — Monthly GST Return Summary</div>
        <div className={styles.reportPeriod}>{fmtDate(from)} to {fmtDate(to)}</div>
      </div>

      {(!hasOutputBreakup || !hasInputBreakup) && (
        <div className={styles.gstNote}>
          <Info size={13} style={{ display: 'inline', marginRight: '0.375rem' }} />
          Tax amounts shown as "—" require GST-tagged ledgers. Tag your Output / Input GST
          ledgers in <strong>Ledgers</strong> → GST / Tax Ledger to enable automatic computation.
        </div>
      )}

      <div style={{ padding: '1.5rem' }}>
        {/* Section 3.1 */}
        <div style={{ marginBottom: '1.5rem' }}>
          <div className={styles.cfSectionTitle}>
            3.1 — Details of Outward Supplies and Inward Supplies Liable to Reverse Charge
          </div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Description</th>
                <th className={styles.right}>Taxable Value</th>
                <th className={styles.right}>IGST</th>
                <th className={styles.right}>CGST</th>
                <th className={styles.right}>SGST</th>
              </tr>
            </thead>
            <tbody>
              <Row label="(a) Outward taxable supplies (other than zero rated, nil rated and exempted)" value={totalSalesTaxable} igst={hasOutputBreakup ? totalSalesIGST : undefined} cgst={hasOutputBreakup ? totalSalesCGST : undefined} sgst={hasOutputBreakup ? totalSalesSGST : undefined} indent />
              <Row label="(b) Outward taxable supplies (zero rated)" value="—" indent />
              <Row label="(c) Other outward supplies (nil rated, exempted)" value="—" indent />
              <Row label="(d) Inward supplies (liable to reverse charge)" value="—" indent />
              <Row label="(e) Non-GST outward supplies" value="—" indent />
              <Row label="Total Outward Supplies" value={totalSalesTaxable} igst={hasOutputBreakup ? totalSalesIGST : undefined} cgst={hasOutputBreakup ? totalSalesCGST : undefined} sgst={hasOutputBreakup ? totalSalesSGST : undefined} bold />
            </tbody>
          </table>
        </div>

        {/* Section 4 */}
        <div style={{ marginBottom: '1.5rem' }}>
          <div className={styles.cfSectionTitle}>
            4 — Eligible ITC (Input Tax Credit)
          </div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Description</th>
                <th className={styles.right}>Taxable Value</th>
                <th className={styles.right}>IGST</th>
                <th className={styles.right}>CGST</th>
                <th className={styles.right}>SGST</th>
              </tr>
            </thead>
            <tbody>
              <Row label="(A) ITC Available — Import of goods" value="—" indent />
              <Row label="(A) ITC Available — Inward supplies from registered persons" value={totalPurchaseTaxable} igst={hasInputBreakup ? totalPurchaseIGST : undefined} cgst={hasInputBreakup ? totalPurchaseCGST : undefined} sgst={hasInputBreakup ? totalPurchaseSGST : undefined} indent />
              <Row label="Total ITC Available" value={totalPurchaseTaxable} igst={hasInputBreakup ? totalPurchaseIGST : undefined} cgst={hasInputBreakup ? totalPurchaseCGST : undefined} sgst={hasInputBreakup ? totalPurchaseSGST : undefined} bold />
              <Row label="(B) ITC Reversed (manual)" value="—" indent />
              <Row label="(C) Net ITC Available" value={totalPurchaseTaxable} igst={hasInputBreakup ? totalPurchaseIGST : undefined} cgst={hasInputBreakup ? totalPurchaseCGST : undefined} sgst={hasInputBreakup ? totalPurchaseSGST : undefined} bold />
            </tbody>
          </table>
        </div>

        {/* Section 5: Net liability */}
        <div style={{
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '1rem 1.25rem',
          display: 'flex', gap: '2rem', flexWrap: 'wrap',
        }}>
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
              Output Tax
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.125rem', color: 'var(--error)' }}>
              {hasOutputBreakup ? fmtAmt(netOutputTax) : fmtAmt(totalSales) + ' *'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
              ITC Available
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.125rem', color: 'var(--success)' }}>
              {hasInputBreakup ? fmtAmt(netITC) : fmtAmt(totalPurchase) + ' *'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
              Net Tax Liability
            </div>
            <div style={{
              fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.125rem',
              color: netTaxLiability > 0 ? 'var(--error)' : 'var(--success)',
            }}>
              {hasOutputBreakup && hasInputBreakup
                ? <>{fmtAmt(Math.abs(netTaxLiability))}<span style={{ fontSize: '0.75rem', marginLeft: '0.25rem' }}>{netTaxLiability > 0 ? 'Payable' : 'Refund'}</span></>
                : fmtAmt(Math.abs(totalSales - totalPurchase)) + ' *'
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function GSTReports() {
  const { user }  = useAuth()
  const companyId = user?.activeCompany?.id ?? ''
  const company   = user?.activeCompany

  const fy = currentFY()
  const [from,    setFrom]    = useState(fy.from)
  const [to,      setTo]      = useState(fy.to)
  const [tab,     setTab]     = useState<Tab>('gstr1')
  const [loading, setLoading] = useState(false)
  const [hasRun,  setHasRun]  = useState(false)
  const [salesRows,    setSalesRows]    = useState<GSTVoucherRow[]>([])
  const [purchaseRows, setPurchaseRows] = useState<GSTVoucherRow[]>([])

  const runReport = async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const [sales, purchases] = await Promise.all([
        fetchGSTVouchers(companyId, from, to, 'sales'),
        fetchGSTVouchers(companyId, from, to, 'purchase'),
      ])
      setSalesRows(sales)
      setPurchaseRows(purchases)
      setHasRun(true)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load GST data')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={`${styles.pageHeader} ${styles.noPrint}`}>
        <h1 className={styles.pageTitle}>GST Reports</h1>
        <div className={styles.headerActions}>
          <button className={styles.btnPrint} onClick={() => exportGstCsv(company?.name ?? 'Company', from, to, tab, salesRows, purchaseRows)} disabled={!hasRun || loading}>
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
      </div>

      {/* Tabs */}
      {hasRun && (
        <div className={`${styles.tabNav} ${styles.noPrint}`}>
          <button
            className={`${styles.tabBtn} ${tab === 'gstr1' ? styles.tabBtnActive : ''}`}
            onClick={() => setTab('gstr1')}
          >
            GSTR-1
            <span className={styles.countBadge}>{salesRows.length}</span>
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'gstr3b' ? styles.tabBtnActive : ''}`}
            onClick={() => setTab('gstr3b')}
          >
            GSTR-3B
          </button>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <FoodStreamMini label="Loading GST data…" />
      ) : !hasRun ? (
        <div className={styles.noData}>
          <FileBarChart2 size={36} style={{ opacity: 0.3 }} />
          <span>Set the period and click Run Report</span>
        </div>
      ) : (
        <div style={{ padding: '0 1.5rem 1.5rem' }}>
          {tab === 'gstr1' && (
            <GSTR1Table
              rows={salesRows}
              company={company ?? null}
              from={from}
              to={to}
            />
          )}
          {tab === 'gstr3b' && (
            <GSTR3BTable
              salesRows={salesRows}
              purchaseRows={purchaseRows}
              company={company ?? null}
              from={from}
              to={to}
            />
          )}
        </div>
      )}
    </div>
  )
}
