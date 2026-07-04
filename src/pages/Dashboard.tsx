import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  FileText, Calendar, Clock, CheckCircle2,
  PlusCircle, Search, BookOpen, BarChart2,
  TrendingUp, Users, ArrowRight,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useApprovalCount } from '@/contexts/ApprovalContext'
import {
  fetchDashboardStats,
  fetchRecentVouchers,
  type DashboardStats,
  type RecentVoucher,
} from '@/lib/dashboard'
import css from './Dashboard.module.css'
import FoodStreamMini from '@/components/FoodStreamMini'

// ── Helpers ───────────────────────────────────────────────────────────────────

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function fmtAmt(n: number) {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n)
}

function todayLabel() {
  return new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
}

function monthLabel() {
  return new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

// ── Voucher type pill colour ───────────────────────────────────────────────────

function typePillClass(nature: string | undefined) {
  if (nature === 'INCOME')  return css.voucherTypePillIncome
  if (nature === 'EXPENSE') return css.voucherTypePillExpense
  if (nature === 'ASSET')   return css.voucherTypePillAsset
  return css.voucherTypePill
}

function statusClass(status: string) {
  if (status === 'approved' || status === 'posted') return css.statusApproved
  if (status === 'pending_approval')                return css.statusPending
  if (status === 'rejected')                        return css.statusRejected
  return css.statusDraft
}

function statusLabel(status: string) {
  if (status === 'pending_approval') return 'Pending'
  if (status === 'posted')           return 'Posted'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

// ── KPI card ──────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label:     string
  value:     number | null
  subLabel:  string
  to:        string
  icon:      React.ReactNode
  valueClass?: string
}

function KpiCard({ label, value, subLabel, to, icon, valueClass }: KpiCardProps) {
  return (
    <Link to={to} className={css.kpiCard}>
      <div className={css.kpiHeader}>
        <span className={css.kpiLabel}>{label}</span>
        <span className={css.kpiIcon}>{icon}</span>
      </div>
      <div className={valueClass ?? css.kpiValue}>
        {value === null ? '—' : value}
      </div>
      <div className={css.kpiLink}>{subLabel} →</div>
    </Link>
  )
}

// ── Recent voucher row ────────────────────────────────────────────────────────

function VoucherRow({ v }: { v: RecentVoucher }) {
  const typeName   = v.voucher_types?.name   ?? '—'
  const typeNature = v.voucher_types?.nature ?? ''
  const narration  = v.narration ?? v.voucher_number ?? '—'

  return (
    <Link to={`/vouchers/edit/${v.id}`} className={css.voucherRow}>
      <span className={typePillClass(typeNature)}>{typeName}</span>
      <div className={css.voucherMeta}>
        <div className={css.voucherNarration}>{narration}</div>
        <div className={css.voucherDate}>{fmtDate(v.voucher_date)}</div>
      </div>
      <div className={css.voucherRight}>
        <div className={css.voucherAmt}>₹ {fmtAmt(v.amount)}</div>
        <div className={statusClass(v.status)}>{statusLabel(v.status)}</div>
      </div>
    </Link>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user }          = useAuth()
  const { pendingCount }  = useApprovalCount()

  const companyId = user?.activeCompany?.id ?? ''
  const role      = user?.activeRole ?? null
  const isSuper   = user?.profile.is_super_admin ?? false
  const canWrite  = isSuper || role === 'admin' || role === 'accounts'

  const [stats,    setStats]    = useState<DashboardStats | null>(null)
  const [vouchers, setVouchers] = useState<RecentVoucher[]>([])
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    if (!companyId) return
    setLoading(true)
    Promise.all([
      fetchDashboardStats(companyId),
      fetchRecentVouchers(companyId, 8),
    ])
      .then(([s, v]) => { setStats(s); setVouchers(v) })
      .catch(() => { /* show empty gracefully */ })
      .finally(() => setLoading(false))
  }, [companyId])

  const firstName = (user?.profile.full_name ?? user?.email ?? '').split(' ')[0]

  // ── Quick actions config ───────────────────────────────────────────────────

  const writeActions = [
    {
      to: '/vouchers/new',
      icon: <PlusCircle size={15} />,
      iconClass: css.iconTeal,
      label: 'New Voucher',
      desc: 'Payment · Receipt · Journal',
    },
    {
      to: '/suspense/new',
      icon: <PlusCircle size={15} />,
      iconClass: css.iconGold,
      label: 'New Suspense',
      desc: 'Advance · Petty cash',
    },
  ]

  const readActions = [
    {
      to: '/vouchers',
      icon: <FileText size={15} />,
      iconClass: css.iconSurface,
      label: 'Voucher Register',
      desc: 'Browse all entries',
    },
    {
      to: '/vouchers/search',
      icon: <Search size={15} />,
      iconClass: css.iconSurface,
      label: 'Search Vouchers',
      desc: 'Filter by ledger · amount',
    },
    {
      to: '/reports/day-book',
      icon: <BookOpen size={15} />,
      iconClass: css.iconSurface,
      label: 'Day Book',
      desc: "Today's activity",
    },
    {
      to: '/reports/trial-balance',
      icon: <BarChart2 size={15} />,
      iconClass: css.iconSurface,
      label: 'Trial Balance',
      desc: 'Account balances',
    },
    {
      to: '/reports/receivables-payables',
      icon: <Users size={15} />,
      iconClass: css.iconSurface,
      label: 'Receivables',
      desc: 'Outstanding FIFO aging',
    },
    {
      to: '/reports/ratios',
      icon: <TrendingUp size={15} />,
      iconClass: css.iconSurface,
      label: 'Ratio Analysis',
      desc: 'Liquidity · Profitability',
    },
  ]

  const actions = canWrite ? [...writeActions, ...readActions] : readActions

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={css.page}>
      {/* Greeting */}
      <div className={css.greeting}>
        <h1 className={css.greetText}>
          {greeting()}, {firstName}
          <span className={css.roleBadge}>{isSuper ? 'super_admin' : (role ?? 'viewer')}</span>
        </h1>
        <p className={css.greetSub}>
          <span className={css.companyName}>{user?.activeCompany?.name ?? '—'}</span>
          {' · '}
          {todayLabel()}
        </p>
      </div>

      {/* KPI cards */}
      {loading ? (
        <div className={css.kpiRow}>
          {[1, 2, 3, 4].map(i => (
            <div key={i} className={css.skeletonCard}>
              <div className={css.shimmer} style={{ width: '40%' }} />
              <div className={css.shimmer} style={{ width: '25%', height: 28, marginTop: 8 }} />
            </div>
          ))}
        </div>
      ) : (
        <div className={css.kpiRow}>
          <KpiCard
            label="Today's Vouchers"
            value={stats?.todayCount ?? 0}
            subLabel="View Day Book"
            to="/reports/day-book"
            icon={<FileText size={16} />}
          />
          <KpiCard
            label={monthLabel()}
            value={stats?.monthCount ?? 0}
            subLabel="View Register"
            to="/vouchers"
            icon={<Calendar size={16} />}
          />
          <KpiCard
            label="Pending Approvals"
            value={pendingCount}
            subLabel="Review now"
            to="/approvals"
            icon={<CheckCircle2 size={16} />}
            valueClass={pendingCount > 0 ? css.kpiValueAmber : css.kpiValue}
          />
          <KpiCard
            label="Open Suspense"
            value={stats?.openSuspenseCount ?? 0}
            subLabel="View advances"
            to="/suspense"
            icon={<Clock size={16} />}
            valueClass={(stats?.openSuspenseCount ?? 0) > 0 ? css.kpiValueTeal : css.kpiValue}
          />
        </div>
      )}

      {/* Body: actions + recent vouchers */}
      <div className={css.body}>
        {/* Quick actions */}
        <div className={css.section}>
          <div className={css.sectionHead}>Quick Actions</div>
          <div className={css.actionGrid}>
            {actions.map(a => (
              <Link key={a.to} to={a.to} className={css.actionBtn}>
                <div className={`${css.actionIconWrap} ${a.iconClass}`}>
                  {a.icon}
                </div>
                <span className={css.actionLabel}>{a.label}</span>
                <span className={css.actionDesc}>{a.desc}</span>
              </Link>
            ))}
          </div>
        </div>

        {/* Recent vouchers */}
        <div className={css.section}>
          <div className={css.sectionHead}>Recent Vouchers</div>
          {loading ? (
            <FoodStreamMini label="Loading recent vouchers…" size={48} />
          ) : vouchers.length === 0 ? (
            <div className={css.emptyState}>
              No vouchers yet for this company.<br />
              {canWrite && (
                <Link to="/vouchers/new" style={{ color: 'var(--teal)', marginTop: '0.5rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Create your first voucher <ArrowRight size={13} />
                </Link>
              )}
            </div>
          ) : (
            <div className={css.voucherList}>
              {vouchers.map(v => <VoucherRow key={v.id} v={v} />)}
            </div>
          )}
          <Link to="/vouchers" className={css.viewAllLink}>
            View all vouchers →
          </Link>
        </div>
      </div>
    </div>
  )
}
