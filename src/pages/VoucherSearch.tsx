import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Loader2, X, ExternalLink, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchAdvancedVoucherSearch,
  type AdvancedFilters,
  type AdvancedVoucherResult,
} from '@/lib/vouchers-list'
import { fetchLedgerOptions, currentFY, fmtDate, fmtAmt, type LedgerOption } from '@/lib/reports'
import styles from './Reports.module.css'

// ── Constants ─────────────────────────────────────────────────────────────────

const NATURE_OPTIONS = [
  { value: '',         label: 'All types'  },
  { value: 'payment',  label: 'Payment'   },
  { value: 'receipt',  label: 'Receipt'   },
  { value: 'journal',  label: 'Journal'   },
  { value: 'contra',   label: 'Contra'    },
  { value: 'purchase', label: 'Purchase'  },
  { value: 'sales',    label: 'Sales'     },
]

const NATURE_COLOR: Record<string, string> = {
  payment:  '#e05252', receipt: '#4caf7d', journal: '#4a9e9e',
  contra: '#c9a84c', purchase: '#e07844', sales: '#7b9fe0',
}

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  draft:            { bg: 'var(--surface-2)',              color: 'var(--text-muted)' },
  pending_approval: { bg: 'rgba(245,158,11,0.12)',          color: '#f59e0b'           },
  posted:           { bg: 'rgba(34,197,94,0.12)',           color: '#22c55e'           },
  cancelled:        { bg: 'rgba(239,68,68,0.08)',           color: '#ef4444'           },
}

function defaultFilters(): AdvancedFilters {
  const fy = currentFY()
  return {
    payee:       '',
    ledgerId:    '',
    dateFrom:    fy.from,
    dateTo:      fy.to,
    amountType:  '',
    amountValue: '',
    nature:      '',
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function VoucherSearch() {
  const { user }  = useAuth()
  const navigate  = useNavigate()
  const companyId = user?.activeCompany?.id ?? ''

  const [filters,  setFilters]  = useState<AdvancedFilters>(defaultFilters())
  const [results,  setResults]  = useState<AdvancedVoucherResult[]>([])
  const [loading,  setLoading]  = useState(false)
  const [hasRun,   setHasRun]   = useState(false)
  const [ledgers,  setLedgers]  = useState<LedgerOption[]>([])
  const [ledgerSearch, setLedgerSearch] = useState('')
  const [ledgerOpen,   setLedgerOpen]   = useState(false)

  // Load ledger options
  useEffect(() => {
    if (!companyId) return
    fetchLedgerOptions(companyId)
      .then(setLedgers)
      .catch(() => { /* non-critical */ })
  }, [companyId])

  const set = (k: keyof AdvancedFilters, v: string) =>
    setFilters(prev => ({ ...prev, [k]: v }))

  const runSearch = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const data = await fetchAdvancedVoucherSearch(companyId, filters)
      setResults(data)
      setHasRun(true)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }, [companyId, filters])

  const clearFilters = () => {
    setFilters(defaultFilters())
    setLedgerSearch('')
    setResults([])
    setHasRun(false)
  }

  // Filtered ledger dropdown
  const filteredLedgers = ledgerSearch
    ? ledgers.filter(l =>
        l.name.toLowerCase().includes(ledgerSearch.toLowerCase()) ||
        l.group_name.toLowerCase().includes(ledgerSearch.toLowerCase())
      ).slice(0, 20)
    : ledgers.slice(0, 20)

  const selectedLedger = ledgers.find(l => l.id === filters.ledgerId)

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={`${styles.pageHeader} ${styles.noPrint}`}>
        <h1 className={styles.pageTitle}>Voucher Search</h1>
        {hasRun && (
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
            {results.length} result{results.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Filter panel */}
      <div className={`${styles.filterBar} ${styles.noPrint}`}
        style={{ flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-start' }}>

        {/* Row 1 */}
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Payee / Party</label>
          <input
            className={styles.filterInput}
            placeholder="Enter party name…"
            value={filters.payee}
            onChange={e => set('payee', e.target.value)}
            style={{ minWidth: '200px' }}
          />
        </div>

        {/* Head of Account (ledger typeahead) */}
        <div className={styles.filterGroup} style={{ position: 'relative', minWidth: '220px' }}>
          <label className={styles.filterLabel}>Head of Account</label>
          <div style={{ position: 'relative' }}>
            <input
              className={styles.filterInput}
              placeholder="Search ledger…"
              value={ledgerOpen ? ledgerSearch : (selectedLedger?.name ?? '')}
              onFocus={() => { setLedgerOpen(true); setLedgerSearch('') }}
              onChange={e => { setLedgerSearch(e.target.value); setLedgerOpen(true) }}
              style={{ paddingRight: '2rem', width: '100%', minWidth: '220px' }}
            />
            {filters.ledgerId
              ? <button
                  onClick={() => { set('ledgerId', ''); setLedgerSearch(''); setLedgerOpen(false) }}
                  style={{
                    position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
                    display: 'flex', padding: 0,
                  }}
                ><X size={13} /></button>
              : <ChevronDown size={13} style={{
                  position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)',
                  color: 'var(--text-dim)', pointerEvents: 'none',
                }} />
            }
          </div>
          {ledgerOpen && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                onClick={() => setLedgerOpen(false)}
              />
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                maxHeight: '220px', overflowY: 'auto', marginTop: '2px',
              }}>
                <div
                  style={{
                    padding: '0.5rem 0.75rem', fontSize: '0.8125rem',
                    color: 'var(--text-muted)', cursor: 'pointer',
                    borderBottom: '1px solid var(--border)',
                  }}
                  onClick={() => { set('ledgerId', ''); setLedgerSearch(''); setLedgerOpen(false) }}
                >
                  Any ledger
                </div>
                {filteredLedgers.map(l => (
                  <div
                    key={l.id}
                    onClick={() => { set('ledgerId', l.id); setLedgerOpen(false) }}
                    style={{
                      padding: '0.5rem 0.75rem', fontSize: '0.875rem',
                      cursor: 'pointer', borderBottom: '1px solid var(--border)',
                      background: filters.ledgerId === l.id ? 'var(--teal-light)' : undefined,
                    }}
                    onMouseEnter={e => { if (filters.ledgerId !== l.id) (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-2)' }}
                    onMouseLeave={e => { if (filters.ledgerId !== l.id) (e.currentTarget as HTMLDivElement).style.background = '' }}
                  >
                    <span style={{ color: 'var(--text)' }}>{l.name}</span>
                    <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>
                      {l.group_name}
                    </span>
                  </div>
                ))}
                {filteredLedgers.length === 0 && (
                  <div style={{ padding: '0.5rem 0.75rem', color: 'var(--text-dim)', fontSize: '0.8125rem' }}>
                    No ledgers found
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Voucher Type</label>
          <select
            className={styles.filterSelect}
            value={filters.nature}
            onChange={e => set('nature', e.target.value)}
            style={{ minWidth: '140px' }}
          >
            {NATURE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>From date</label>
          <input
            type="date"
            className={styles.filterInput}
            value={filters.dateFrom}
            onChange={e => set('dateFrom', e.target.value)}
          />
        </div>

        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>To date</label>
          <input
            type="date"
            className={styles.filterInput}
            value={filters.dateTo}
            onChange={e => set('dateTo', e.target.value)}
          />
        </div>

        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Amount</label>
          <div style={{ display: 'flex', gap: '0.375rem' }}>
            <select
              className={styles.filterSelect}
              value={filters.amountType}
              onChange={e => set('amountType', e.target.value as AdvancedFilters['amountType'])}
              style={{ minWidth: '110px' }}
            >
              <option value="">Any amount</option>
              <option value="exact">Exact</option>
              <option value="gte">At least</option>
              <option value="lte">At most</option>
            </select>
            {filters.amountType && (
              <input
                type="number"
                className={styles.filterInput}
                placeholder="0.00"
                value={filters.amountValue}
                onChange={e => set('amountValue', e.target.value)}
                style={{ width: '110px' }}
              />
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', alignSelf: 'flex-end' }}>
          <button className={styles.btnRun} onClick={runSearch} disabled={loading}>
            {loading
              ? <><Loader2 size={13} className={styles.spin} /> Searching…</>
              : <><Search size={13} /> Search</>
            }
          </button>
          <button
            onClick={clearFilters}
            style={{
              padding: '0.5rem 0.875rem', background: 'none',
              border: '1px solid var(--border-2)', borderRadius: 'var(--radius)',
              color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.875rem',
            }}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <FoodStreamMini label="Searching…" />
      ) : !hasRun ? (
        <div className={styles.noData}>
          <Search size={36} style={{ opacity: 0.3 }} />
          <span>Set your filters and click Search</span>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-dim)' }}>
            Search by payee, head of account, date range, or amount
          </span>
        </div>
      ) : results.length === 0 ? (
        <div className={styles.noData}>
          <span>No vouchers found matching the given filters.</span>
        </div>
      ) : (
        <div className={styles.reportDoc}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Voucher No.</th>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Party / Payee</th>
                  <th>Narration</th>
                  <th className={styles.right}>Amount</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, idx) => {
                  const nc = NATURE_COLOR[r.nature] ?? 'var(--text-muted)'
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
                      <td>
                        <span style={{
                          display: 'inline-block', padding: '0.125rem 0.5rem',
                          border: `1px solid ${nc}`, borderRadius: '4px',
                          fontSize: '0.6875rem', fontWeight: 700,
                          color: nc, letterSpacing: '0.04em', textTransform: 'uppercase',
                        }}>
                          {r.voucher_type}
                        </span>
                      </td>
                      <td style={{ maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.party_name ?? <span className={styles.dim}>—</span>}
                      </td>
                      <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          className={styles.dim}>
                        {r.narration ?? '—'}
                      </td>
                      <td className={`${styles.right} ${styles.mono}`}>
                        {fmtAmt(r.amount)}
                      </td>
                      <td>
                        <span style={{
                          display: 'inline-block', padding: '0.125rem 0.5rem',
                          borderRadius: '20px', fontSize: '0.75rem', fontWeight: 600,
                          background: st.bg, color: st.color,
                        }}>
                          {r.status === 'pending_approval' ? 'Pending' : r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                        </span>
                      </td>
                      <td>
                        <button
                          onClick={() => navigate(`/vouchers/${r.id}/edit`)}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: 'var(--text-dim)', padding: '2px',
                          }}
                          title="Open voucher"
                        >
                          <ExternalLink size={13} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className={styles.grandTotalRow}>
                  <td colSpan={6}><strong>Total ({results.length} vouchers)</strong></td>
                  <td className={`${styles.right} ${styles.drValue}`}>
                    {fmtAmt(results.reduce((s, r) => s + r.amount, 0))}
                  </td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
