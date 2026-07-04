import { useState } from 'react'
import { Printer, FileBarChart2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchTrialBalance,
  currentFY,
  fmtDate,
  fmtAmt,
  type TrialBalanceLedgerRow,
} from '@/lib/reports'
import FoodStreamMini from '@/components/FoodStreamMini'
import css from './Reports.module.css'
import s3css from './ScheduleIII.module.css'

// ── Schedule III mapping ───────────────────────────────────────────────────────
// Maps Pramaana ledger group names to Companies Act Schedule III line items.
// RFPL-specific (private limited company). RHHF is a partnership — different format.
//
// ⚠ CLASSIFICATION ASSUMPTIONS — verify with CA before ROC filing:
//
// "Duties & Taxes" → curr_liab:  CORRECT only if GST Input Credit ledgers are
//   under the "Current Assets" group (as Pramaana's ledger setup requires).
//   If any Input Credit ledger is under "Duties & Taxes", it will be mis-classified
//   as a liability. Fix: move those ledgers to the "Current Assets" group.
//
// "Provisions" → Short-term only:  Schedule III has both Long-term Provisions
//   (non-current, e.g. gratuity) and Short-term Provisions (current).
//   All Pramaana "Provisions" ledgers are currently treated as short-term.
//   If RFPL has long-term provisions, create a separate "Long-term Provisions"
//   ledger group and extend this mapping.
//
// "Loans (Liability)" → Long-term Borrowings:  Cash-credit / overdraft facilities
//   should be "Short-term Borrowings" under Current Liabilities.
//   If RFPL has any such facility, create a separate "Short-term Borrowings"
//   ledger group and extend this mapping.
//
// "Suspense Account" → DYNAMIC: routed at runtime by actual balance sign.
//   Dr balance (net > 0) → Current Assets (unresolved receivable).
//   Cr balance (net < 0) → Current Liabilities (unresolved payable).
//
// "Loans & Advances (Given)" → Long-term only:  Staff advances recoverable
//   within 12 months should be "Short-term Loans and Advances" under Current Assets.
//   Treat this as an approximation unless advances are separately tagged.

type S3Section =
  | 'equity'
  | 'non_curr_liab'
  | 'curr_liab'
  | 'non_curr_asset'
  | 'curr_asset'
  | 'revenue'
  | 'expense'

interface S3Mapping {
  section:    S3Section
  heading:    string       // Major head (e.g. "Non-Current Assets")
  subHeading: string       // Line item (e.g. "Trade Receivables")
  order:      number       // Display order within section
}

const GROUP_MAP: Record<string, S3Mapping> = {
  // ── EQUITY & LIABILITIES ─────────────────────────────────────────────────
  'Capital Account':          { section: 'equity',        heading: "Shareholders' Funds",   subHeading: 'Share Capital',                    order: 1 },
  'Reserves & Surplus':       { section: 'equity',        heading: "Shareholders' Funds",   subHeading: 'Reserves and Surplus',             order: 2 },
  'Loans (Liability)':        { section: 'non_curr_liab', heading: 'Non-Current Liabilities', subHeading: 'Long-term Borrowings',           order: 1 },
  'Sundry Creditors':         { section: 'curr_liab',     heading: 'Current Liabilities',   subHeading: 'Trade Payables',                  order: 1 },
  'Current Liabilities':      { section: 'curr_liab',     heading: 'Current Liabilities',   subHeading: 'Other Current Liabilities',        order: 2 },
  'Duties & Taxes':           { section: 'curr_liab',     heading: 'Current Liabilities',   subHeading: 'Duties and Taxes Payable',         order: 2 },
  'Provisions':               { section: 'curr_liab',     heading: 'Current Liabilities',   subHeading: 'Short-term Provisions',            order: 3 },
  // Suspense Account: no static mapping — dynamically routed by balance sign (see routeRow)
  // ── ASSETS ───────────────────────────────────────────────────────────────
  'Fixed Assets':             { section: 'non_curr_asset', heading: 'Non-Current Assets',   subHeading: 'Fixed Assets',                    order: 1 },
  'Investments':              { section: 'non_curr_asset', heading: 'Non-Current Assets',   subHeading: 'Non-Current Investments',          order: 2 },
  'Loans & Advances (Given)': { section: 'non_curr_asset', heading: 'Non-Current Assets',   subHeading: 'Long-term Loans and Advances',    order: 3 },
  'Stock in Hand':            { section: 'curr_asset',    heading: 'Current Assets',        subHeading: 'Inventories',                      order: 1 },
  'Sundry Debtors':           { section: 'curr_asset',    heading: 'Current Assets',        subHeading: 'Trade Receivables',                order: 2 },
  'Cash in Hand':             { section: 'curr_asset',    heading: 'Current Assets',        subHeading: 'Cash and Cash Equivalents',        order: 3 },
  'Bank Accounts':            { section: 'curr_asset',    heading: 'Current Assets',        subHeading: 'Cash and Cash Equivalents',        order: 3 },
  'Current Assets':           { section: 'curr_asset',    heading: 'Current Assets',        subHeading: 'Other Current Assets',             order: 4 },
  // ── P&L ──────────────────────────────────────────────────────────────────
  'Sales Accounts':           { section: 'revenue',  heading: 'Revenue',  subHeading: 'Revenue from Operations',            order: 1 },
  'Other Income':             { section: 'revenue',  heading: 'Revenue',  subHeading: 'Other Income',                       order: 2 },
  'Purchase Accounts':        { section: 'expense',  heading: 'Expenses', subHeading: 'Purchases / Cost of Materials',      order: 1 },
  'Direct Expenses':          { section: 'expense',  heading: 'Expenses', subHeading: 'Manufacturing and Other Expenses',   order: 2 },
  'Indirect Expenses':        { section: 'expense',  heading: 'Expenses', subHeading: 'Other Expenses',                     order: 3 },
  'Expenditure':              { section: 'expense',  heading: 'Expenses', subHeading: 'Other Expenses',                     order: 3 },
}

// ── Dynamic routing for balance-sign-dependent groups ─────────────────────────
// "Suspense Account" can carry either a Dr balance (unresolved receivable → asset)
// or a Cr balance (unresolved payable → liability). We resolve at row level.

function resolveSection(row: TrialBalanceLedgerRow): { mapping: S3Mapping; dynamic?: boolean } | null {
  if (row.group_name === 'Suspense Account') {
    // net > 0 → Dr balance → treat as current asset
    // net < 0 → Cr balance → treat as current liability
    const isDr = row.net >= 0
    return {
      mapping: {
        section:    isDr ? 'curr_asset' : 'curr_liab',
        heading:    isDr ? 'Current Assets' : 'Current Liabilities',
        subHeading: isDr ? 'Other Current Assets (Suspense)' : 'Other Current Liabilities (Suspense)',
        order:      5,
      },
      dynamic: true,
    }
  }
  const m = GROUP_MAP[row.group_name]
  return m ? { mapping: m } : null
}

// ── Build Schedule III structure ───────────────────────────────────────────────

interface S3Line {
  subHeading: string
  rows:       TrialBalanceLedgerRow[]
  amount:     number
  order:      number
}

interface S3Head {
  heading:    string
  lines:      S3Line[]
  total:      number
}

function buildSection(rows: TrialBalanceLedgerRow[], section: S3Section): S3Head[] {
  const headMap = new Map<string, Map<string, { rows: TrialBalanceLedgerRow[]; order: number }>>()

  for (const r of rows) {
    const resolved = resolveSection(r)
    if (!resolved || resolved.mapping.section !== section) continue
    const m = resolved.mapping

    if (!headMap.has(m.heading)) headMap.set(m.heading, new Map())
    const subMap = headMap.get(m.heading)!
    if (!subMap.has(m.subHeading)) subMap.set(m.subHeading, { rows: [], order: m.order })
    subMap.get(m.subHeading)!.rows.push(r)
  }

  const result: S3Head[] = []
  for (const [heading, subMap] of headMap) {
    const lines: S3Line[] = []
    for (const [subHeading, { rows: subRows, order }] of subMap) {
      const isAsset    = section === 'curr_asset' || section === 'non_curr_asset'
      const isRevenue  = section === 'revenue'
      const amount = subRows.reduce((s, r) => {
        // ── Sign convention ─────────────────────────────────────────────────
        // Assets:           sum raw r.net  (Dr-normal = positive; contra-assets
        //                   such as Accumulated Depreciation are Cr-normal = negative
        //                   and MUST net off, not be forced positive by abs()).
        // Liabilities/Equity: sum -(r.net) (Cr-normal = negative net → flip to positive
        //                   for display; contra-liabilities reduce the total correctly).
        // P&L Revenue:      same pattern as the existing P&L code → -(r.net)
        // P&L Expense:      r.net directly (Dr-normal = positive).
        if (isRevenue)             return s + (-r.net)
        if (section === 'expense') return s + r.net
        if (isAsset)               return s + r.net           // contra-assets net out naturally
        return s + (-r.net)        // liabilities + equity: flip Cr-normal to positive
      }, 0)
      lines.push({ subHeading, rows: subRows, amount, order })
    }
    lines.sort((a, b) => a.order - b.order)
    const total = lines.reduce((s, l) => s + l.amount, 0)
    result.push({ heading, lines, total })
  }
  return result
}

// ── Render helpers ─────────────────────────────────────────────────────────────

function S3Section({ heads, side }: { heads: S3Head[]; side: 'liab' | 'asset' | 'pl' }) {
  if (!heads.length) return null
  return (
    <>
      {heads.map(head => (
        <div key={head.heading} className={s3css.headBlock}>
          <div className={s3css.headLabel}>{head.heading}</div>
          {head.lines.map(line => (
            <div key={line.subHeading} className={s3css.lineRow}>
              <span className={s3css.lineName}>{line.subHeading}</span>
              <span className={s3css.lineAmt}>{fmtAmt(line.amount)}</span>
            </div>
          ))}
          <div className={s3css.headTotal}>
            <span>Total — {head.heading}</span>
            <span>{fmtAmt(head.total)}</span>
          </div>
        </div>
      ))}
    </>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function ScheduleIII() {
  const { user }   = useAuth()
  const companyId  = user?.activeCompany?.id   ?? ''
  const companyName = user?.activeCompany?.name ?? '—'

  const fy = currentFY()
  const [to,      setTo]      = useState(fy.to)
  const [loading, setLoading] = useState(false)
  const [hasRun,  setHasRun]  = useState(false)

  // Balance Sheet sections
  const [equity,        setEquity]        = useState<S3Head[]>([])
  const [nonCurrLiab,   setNonCurrLiab]   = useState<S3Head[]>([])
  const [currLiab,      setCurrLiab]      = useState<S3Head[]>([])
  const [nonCurrAsset,  setNonCurrAsset]  = useState<S3Head[]>([])
  const [currAsset,     setCurrAsset]     = useState<S3Head[]>([])

  // P&L sections
  const [revenue,  setRevenue]  = useState<S3Head[]>([])
  const [expense,  setExpense]  = useState<S3Head[]>([])

  // Totals
  const [totalEquityLiab,  setTotalEquityLiab]  = useState(0)
  const [totalAssets,      setTotalAssets]       = useState(0)
  const [netProfit,        setNetProfit]         = useState(0)
  const [totalRevenue,     setTotalRevenue]      = useState(0)
  const [totalExpense,     setTotalExpense]      = useState(0)

  // Unmapped groups (need to extend GROUP_MAP)
  const [unmapped, setUnmapped] = useState<string[]>([])

  const runReport = async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const tb = await fetchTrialBalance(companyId, to)

      const eq   = buildSection(tb.rows, 'equity')
      const ncl  = buildSection(tb.rows, 'non_curr_liab')
      const cl   = buildSection(tb.rows, 'curr_liab')
      const nca  = buildSection(tb.rows, 'non_curr_asset')
      const ca   = buildSection(tb.rows, 'curr_asset')
      const rev  = buildSection(tb.rows, 'revenue')
      const exp  = buildSection(tb.rows, 'expense')

      // Net profit flows into equity (Reserves and Surplus)
      const totalRev  = rev.flatMap(h => h.lines).reduce((s, l) => s + l.amount, 0)
      const totalExp  = exp.flatMap(h => h.lines).reduce((s, l) => s + l.amount, 0)
      const np        = totalRev - totalExp

      const totalLiab = [eq, ncl, cl].flat().reduce((s, h) => s + h.total, 0) + np
      const totalAst  = [nca, ca].flat().reduce((s, h) => s + h.total, 0)

      setEquity(eq); setNonCurrLiab(ncl); setCurrLiab(cl)
      setNonCurrAsset(nca); setCurrAsset(ca)
      setRevenue(rev); setExpense(exp)
      setTotalEquityLiab(totalLiab); setTotalAssets(totalAst)
      setNetProfit(np); setTotalRevenue(totalRev); setTotalExpense(totalExp)

      // Surface any groups not resolved by resolveSection
      const um = [...new Set(tb.rows.map(r => r.group_name).filter(g => !resolveSection({ group_name: g, net: 0 } as TrialBalanceLedgerRow)))]
      setUnmapped(um)

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
        <h1 className={css.pageTitle}>Schedule III Financials</h1>
        <div className={css.headerActions}>
          <input
            type="date"
            className={css.dateInput}
            value={to}
            onChange={e => { setTo(e.target.value); setHasRun(false) }}
          />
          <button className={css.btnRun} onClick={runReport} disabled={loading}>
            {loading ? <Loader2 size={14} className={css.spin} /> : <FileBarChart2 size={14} />}
            Generate
          </button>
          {hasRun && (
            <button className={css.btnPrint} onClick={() => window.print()}>
              <Printer size={13} /> Print
            </button>
          )}
        </div>
      </div>

      <p className={css.subNote}>
        As at {fmtDate(to)} · {companyName}
        {user?.activeCompany?.code === 'RFPL'
          ? ' · Companies Act 2013 — Schedule III format'
          : ' · ⚠ Schedule III applies to Private Limited Companies only (RFPL). RHHF is a Partnership — this format does not apply.'}
      </p>

      {/* Management report disclaimer — always visible */}
      <div className={s3css.filingDisclaimer}>
        📋 <strong>Management Report — Not for statutory filing.</strong>{' '}
        This is an approximation of Schedule III format derived from ledger group totals.
        It does not include the 2021 MCA amendment requirements: Trade Receivables / Payables
        ageing schedules, MSME dues disclosure, or ratio disclosures.
        Submit your actual ROC filing using your CA's audited financials.
      </div>

      {loading && <FoodStreamMini label="Building Schedule III…" size={48} />}

      {!loading && hasRun && (
        <>
          {/* ── Unmapped groups warning ────────────────────────────────── */}
          {unmapped.length > 0 && (
            <div className={s3css.unmappedWarn}>
              ⚠ {unmapped.length} ledger group(s) not mapped to Schedule III:
              {' '}<strong>{unmapped.join(', ')}</strong>.
              Their balances are excluded from this report. Update GROUP_MAP in ScheduleIII.tsx.
            </div>
          )}

          <div className={s3css.twoCol}>

            {/* ── LEFT: Equity & Liabilities ────────────────────────── */}
            <div className={s3css.col}>
              <div className={s3css.colTitle}>Equity &amp; Liabilities</div>

              <div className={s3css.majorSection}>
                <S3Section heads={equity} side="liab" />
                {netProfit !== 0 && (
                  <div className={s3css.npLine}>
                    <span>Profit / (Loss) for the year</span>
                    <span className={netProfit >= 0 ? s3css.profit : s3css.loss}>
                      {fmtAmt(Math.abs(netProfit))}
                      {netProfit < 0 ? ' (Loss)' : ''}
                    </span>
                  </div>
                )}
              </div>

              <S3Section heads={nonCurrLiab} side="liab" />
              <S3Section heads={currLiab} side="liab" />

              <div className={s3css.grandTotal}>
                <span>Total Equity &amp; Liabilities</span>
                <span>{fmtAmt(totalEquityLiab)}</span>
              </div>
            </div>

            {/* ── RIGHT: Assets ─────────────────────────────────────── */}
            <div className={s3css.col}>
              <div className={s3css.colTitle}>Assets</div>
              <S3Section heads={nonCurrAsset} side="asset" />
              <S3Section heads={currAsset} side="asset" />

              <div className={s3css.grandTotal}>
                <span>Total Assets</span>
                <span>{fmtAmt(totalAssets)}</span>
              </div>

              {Math.abs(totalEquityLiab - totalAssets) > 1 && (
                <div className={s3css.balanceWarn}>
                  ⚠ Balance sheet does not balance — difference: ₹{fmtAmt(Math.abs(totalEquityLiab - totalAssets))}
                </div>
              )}
            </div>
          </div>

          {/* ── Statement of Profit & Loss ─────────────────────────────── */}
          <div className={s3css.plSection}>
            <div className={s3css.plTitle}>
              Statement of Profit &amp; Loss — FY ending {fmtDate(to)}
            </div>
            <div className={s3css.plGrid}>
              <div>
                <S3Section heads={revenue} side="pl" />
                <div className={s3css.plSubtotal}>
                  <span>Total Revenue (I)</span>
                  <span>{fmtAmt(totalRevenue)}</span>
                </div>
              </div>
              <div>
                <S3Section heads={expense} side="pl" />
                <div className={s3css.plSubtotal}>
                  <span>Total Expenses (II)</span>
                  <span>{fmtAmt(totalExpense)}</span>
                </div>
              </div>
            </div>
            <div className={s3css.plNetProfit}>
              <span>Profit / (Loss) before Tax (I − II)</span>
              <span className={netProfit >= 0 ? s3css.profit : s3css.loss}>
                {fmtAmt(Math.abs(netProfit))}{netProfit < 0 ? ' (Loss)' : ''}
              </span>
            </div>
            <p className={s3css.plNote}>
              Tax expense and deferred tax are not included — enter as Journal vouchers in the relevant ledgers and re-run.
            </p>
          </div>
        </>
      )}
    </div>
  )
}
