import { useState } from 'react'
import { Download, FileBarChart2, Loader2, Printer } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { currentFY, fmtAmt } from '@/lib/reports'
import FoodStreamMini from '@/components/FoodStreamMini'
import css from './Reports.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TdsRow {
  entity_name:       string
  entity_pan:        string | null
  tds_section_code:  string | null
  ledger_name:       string
  tds_rate:          number | null
  payment_dates:     string[]
  gross_amount:      number
  tds_amount:        number
  voucher_count:     number
}

// ── Query ─────────────────────────────────────────────────────────────────────

async function fetchTdsData(companyId: string, from: string, to: string): Promise<TdsRow[]> {
  // v_tds_report_entries flattens the voucher_entries → vouchers → ledgers +
  // registry.entities join, removing the cross-schema embed that caused parse errors.
  const { data: entries, error: ee } = await supabase
    .schema('pramaana')
    .from('v_tds_report_entries')
    .select('ledger_id,entry_type,amount,voucher_id,voucher_date,status,party_name,party_pan,tds_section_code,ledger_name,tds_rate,is_tds_payable_ledger')
    .eq('company_id', companyId)
    .gte('voucher_date', from)
    .lte('voucher_date', to)
    .in('status', ['approved', 'completed', 'awaiting_payment', 'posted'])

  if (ee) throw new Error('Failed to load TDS entries: ' + ee.message)
  if (!entries?.length) return []

  // Aggregate by deductee PAN (or name as fallback) + TDS section
  // Three-way entry_type logic:
  //   Cr on TDS Payable ledger  → tds_amount (deduction at source)
  //   Dr on TDS Payable ledger  → skip       (CBDT remittance, not a payment to deductee)
  //   Dr on non-payable ledger  → gross_amount (future: once party ledgers are tagged)
  type AggKey = string
  const agg = new Map<AggKey, TdsRow>()

  for (const e of entries) {
    if (e.is_tds_payable_ledger && e.entry_type === 'Dr') continue  // remittance

    const sectionCode = e.tds_section_code ?? 'Unclassified'
    const key = `${e.party_pan ?? e.party_name ?? 'none'}__${sectionCode}`

    if (!agg.has(key)) {
      agg.set(key, {
        entity_name:      e.party_name      ?? 'Unknown',
        entity_pan:       e.party_pan       ?? null,
        tds_section_code: e.tds_section_code,
        ledger_name:      e.ledger_name     ?? '',
        tds_rate:         e.tds_rate        ?? null,
        payment_dates:    [],
        gross_amount:     0,
        tds_amount:       0,
        voucher_count:    0,
      })
    }

    const row    = agg.get(key)!
    const amount = Number(e.amount) || 0

    if (e.entry_type === 'Cr') {
      row.tds_amount += amount
      row.voucher_count++
      if (!row.payment_dates.includes(e.voucher_date)) {
        row.payment_dates.push(e.voucher_date)
      }
    } else {
      row.gross_amount += amount
    }
  }

  return [...agg.values()].sort((a, b) =>
    (a.tds_section_code ?? '').localeCompare(b.tds_section_code ?? '') ||
    a.entity_name.localeCompare(b.entity_name)
  )
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCsv(rows: TdsRow[], from: string, to: string, companyName: string) {
  const header = [
    'Deductee Name', 'PAN', 'Section', 'TDS Ledger', 'Rate %',
    'Deductions', 'Gross Amount', 'TDS Deducted',
    'Deduction Dates',
  ].join(',')

  const lines = rows.map(r => [
    `"${r.entity_name}"`,
    r.entity_pan ?? 'N/A',
    r.tds_section_code ?? 'Unclassified',
    `"${r.ledger_name}"`,
    r.tds_rate ?? '',
    r.voucher_count,
    r.gross_amount > 0 ? r.gross_amount.toFixed(2) : '',
    r.tds_amount.toFixed(2),
    `"${r.payment_dates.sort().join('; ')}"`,
  ].join(','))

  const csv = [header, ...lines].join('\n')

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `tds_26q_${from}_to_${to}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Section label helper ───────────────────────────────────────────────────────

const SECTION_LABELS: Record<string, string> = {
  '192':   '192 — Salary',
  '194':   '194 — Dividends',
  '194C':  '194C — Contractor / Sub-contractor',
  '194J':  '194J — Professional / Technical / Royalty',
  '194Q':  '194Q — Purchase of Goods (>₹50L)',
  '194I':  '194I — Rent',
  '194H':  '194H — Commission / Brokerage',
  '194A':  '194A — Interest (other than securities)',
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function TdsReports() {
  const { user }    = useAuth()
  const companyId   = user?.activeCompany?.id   ?? ''
  const companyName = user?.activeCompany?.name ?? '—'

  const fy = currentFY()
  const [from,    setFrom]    = useState(fy.from)
  const [to,      setTo]      = useState(fy.to)
  const [loading, setLoading] = useState(false)
  const [rows,    setRows]    = useState<TdsRow[]>([])
  const [hasRun,  setHasRun]  = useState(false)

  const totalTds   = rows.reduce((s, r) => s + r.tds_amount, 0)
  const totalGross = rows.reduce((s, r) => s + r.gross_amount, 0)

  const runReport = async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const data = await fetchTdsData(companyId, from, to)
      setRows(data)
      setHasRun(true)
    } catch (e: unknown) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={css.page}>
      <div className={css.pageHeader}>
        <h1 className={css.pageTitle}>TDS Reports — Form 26Q Data</h1>
        <div className={css.headerActions}>
          <input type="date" className={css.dateInput} value={from} onChange={e => { setFrom(e.target.value); setHasRun(false) }} />
          <span style={{ color: 'var(--text-dim)', fontSize: '0.875rem' }}>to</span>
          <input type="date" className={css.dateInput} value={to} onChange={e => { setTo(e.target.value); setHasRun(false) }} />
          <button className={css.btnRun} onClick={runReport} disabled={loading}>
            {loading ? <Loader2 size={14} className={css.spin} /> : <FileBarChart2 size={14} />}
            Generate
          </button>
          {hasRun && rows.length > 0 && (
            <button className={css.btnPrint} onClick={() => exportCsv(rows, from, to, companyName)}>
              <Download size={13} /> Export CSV
            </button>
          )}
          {hasRun && (
            <button className={css.btnPrint} onClick={() => window.print()}>
              <Printer size={13} /> Print / PDF
            </button>
          )}
        </div>
      </div>

      <p className={css.subNote}>
        {companyName} · {from} to {to} · Ledgers tagged <em>is_tds_applicable = true</em>
      </p>

      {loading && <FoodStreamMini label="Loading TDS transactions…" size={48} />}

      {!loading && hasRun && rows.length === 0 && (
        <div className={css.emptyState}>
          No TDS-applicable ledgers found, or no posted vouchers in this date range.
          <br />
          Tag ledgers with <strong>TDS Applicable = Yes</strong> and <strong>Section Code</strong> in the Ledger Master.
        </div>
      )}

      {!loading && hasRun && rows.length > 0 && (
        <>
          <div className={css.summaryBar}>
            <span>Deductees: <strong>{new Set(rows.map(r => r.entity_name)).size}</strong></span>
            <span>Transactions: <strong>{rows.reduce((s, r) => s + r.voucher_count, 0)}</strong></span>
            <span>Gross Payments: <strong>₹ {fmtAmt(totalGross)}</strong></span>
            <span>Total TDS: <strong>₹ {fmtAmt(totalTds)}</strong></span>
          </div>

          <table className={css.table}>
            <thead>
              <tr>
                <th>Deductee</th>
                <th>PAN</th>
                <th>Section</th>
                <th>TDS Ledger</th>
                <th className={css.numCol}>Rate %</th>
                <th className={css.numCol}>Deductions</th>
                <th className={css.numCol}>Gross Amt ²</th>
                <th className={css.numCol}>TDS Deducted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.entity_name}</td>
                  <td className={r.entity_pan ? '' : css.missing}>
                    {r.entity_pan ?? '⚠ PAN missing'}
                  </td>
                  <td>
                    <span title={SECTION_LABELS[r.tds_section_code ?? ''] ?? ''}>
                      {r.tds_section_code ?? '⚠ Unclassified'}
                    </span>
                  </td>
                  <td className={css.muted}>{r.ledger_name}</td>
                  <td className={css.numCol}>{r.tds_rate ?? '—'}</td>
                  <td className={css.numCol}>{r.voucher_count}</td>
                  <td className={css.numCol}>{r.gross_amount > 0 ? fmtAmt(r.gross_amount) : '—'}</td>
                  <td className={css.numCol}>{fmtAmt(r.tds_amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6}><strong>Total</strong></td>
                <td className={css.numCol}><strong>{fmtAmt(totalGross)}</strong></td>
                <td className={css.numCol}><strong>{fmtAmt(totalTds)}</strong></td>
              </tr>
            </tfoot>
          </table>

          <p className={css.footNote}>
            Export the CSV and use it to fill Form 26Q via the TRACES portal or your TDS return filing software.
            Challan details (BSR code, date of deposit, challan serial number) must be added manually from your bank records.
            <br />
            ² Gross Amt is populated once party/expense ledgers are linked via the TDS deduction engine (C2). Until then, use Gross Amt from your payment vouchers.
          </p>
        </>
      )}
    </div>
  )
}
