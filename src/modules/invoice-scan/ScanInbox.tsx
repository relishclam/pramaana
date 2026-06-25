import { useState }  from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ScanLine }  from 'lucide-react'
import { useAuth }   from '@/contexts/AuthContext'
import {
  useInvoiceScans,
  type ScanStatus,
  type ScanType,
  type InvoiceScan,
} from './hooks/useInvoiceScans'
import css from './ScanInbox.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function fmtAmount(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n)
}

function StatusBadge({ status }: { status: ScanStatus }) {
  const map: Record<ScanStatus, { label: string; cls: string }> = {
    pending:         { label: 'Pending',        cls: css.badgePending  },
    reviewed:        { label: 'Reviewed',        cls: css.badgeReviewed },
    voucher_created: { label: 'Voucher Created', cls: css.badgeCreated  },
    rejected:        { label: 'Rejected',        cls: css.badgeRejected },
  }
  const { label, cls } = map[status] ?? { label: status, cls: css.badgePending }
  return <span className={`${css.badge} ${cls}`}>{label}</span>
}

function ConfBadge({ conf }: { conf: number | null }) {
  if (conf === null || conf === 0) return <span className={css.tdMuted}>—</span>
  const pct = Math.round(conf * 100)
  const cls = pct >= 85 ? css.confHigh : pct >= 65 ? css.confMedium : css.confLow
  return <span className={`${css.confBadge} ${cls}`}>{pct}%</span>
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ScanInbox() {
  const { user }  = useAuth()
  const navigate  = useNavigate()
  const companyId = user?.activeCompany?.id ?? ''

  const [type,     setType]     = useState<ScanType | ''>('')
  const [status,   setStatus]   = useState<ScanStatus | ''>('pending')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo,   setDateTo]   = useState('')

  const { scans, loading, error, refresh } = useInvoiceScans({
    companyId,
    type:     type     || undefined,
    status:   status   || undefined,
    dateFrom: dateFrom || undefined,
    dateTo:   dateTo   || undefined,
  })

  const resetFilters = () => {
    setType('')
    setStatus('pending')
    setDateFrom('')
    setDateTo('')
  }

  const handleRow = (scan: InvoiceScan) => {
    navigate(`/invoices/inbox/${scan.id}`)
  }

  return (
    <div className={css.wrap}>
      <div className={css.topRow}>
        <h1 className={css.heading}>Invoice Inbox</h1>
        <Link to="/invoices/scan" className={css.scanBtn}>
          <ScanLine size={16} /> Scan Invoice
        </Link>
      </div>

      {/* Filters */}
      <div className={css.filters}>
        <div className={css.filterGroup}>
          <label className={css.filterLabel}>Type</label>
          <select
            className={css.filterSelect}
            value={type}
            onChange={e => setType(e.target.value as ScanType | '')}
          >
            <option value="">All</option>
            <option value="purchase">Purchase</option>
            <option value="sale">Sale</option>
          </select>
        </div>

        <div className={css.filterGroup}>
          <label className={css.filterLabel}>Status</label>
          <select
            className={css.filterSelect}
            value={status}
            onChange={e => setStatus(e.target.value as ScanStatus | '')}
          >
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="reviewed">Reviewed</option>
            <option value="voucher_created">Voucher Created</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>

        <div className={css.filterGroup}>
          <label className={css.filterLabel}>From</label>
          <input
            type="date"
            className={css.filterInput}
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
          />
        </div>

        <div className={css.filterGroup}>
          <label className={css.filterLabel}>To</label>
          <input
            type="date"
            className={css.filterInput}
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
          />
        </div>

        <button className={css.filterReset} onClick={resetFilters}>Reset</button>
      </div>

      {/* Table */}
      {loading ? (
        <div className={css.loading}>
          <div className={css.spinner} />
          Loading…
        </div>
      ) : error ? (
        <div className={css.errorBox}>{error}</div>
      ) : scans.length === 0 ? (
        <div className={css.empty}>No scans found for the selected filters.</div>
      ) : (
        <div className={css.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Party</th>
                <th>Invoice No</th>
                <th>Amount</th>
                <th>Conf.</th>
                <th>Status</th>
                <th>Scan Ref</th>
              </tr>
            </thead>
            <tbody>
              {scans.map(scan => (
                <tr key={scan.id} onClick={() => handleRow(scan)}>
                  <td>{fmtDate(scan.invoice_date)}</td>
                  <td style={{ textTransform: 'capitalize' }}>{scan.type}</td>
                  <td>{scan.party_name ?? <span className={css.tdMuted}>—</span>}</td>
                  <td className={css.tdMuted}>{scan.invoice_no ?? '—'}</td>
                  <td className={css.tdAmount}>{fmtAmount(scan.total_amount)}</td>
                  <td><ConfBadge conf={scan.confidence} /></td>
                  <td><StatusBadge status={scan.status} /></td>
                  <td className={css.tdRef}>{scan.scan_ref}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
