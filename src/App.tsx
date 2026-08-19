import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom'
import { useState, useEffect, useMemo, useRef } from 'react'
import { ChevronDown, X, Menu } from 'lucide-react'
import { Toaster } from 'sonner'
import css from './App.module.css'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import Login from '@/pages/Login'
import SetPassword from '@/pages/SetPassword'
import CompanySelector from '@/pages/CompanySelector'
import Ledgers from '@/pages/Ledgers'
import VoucherEntry from '@/pages/VoucherEntry'
import ApprovalQueue from '@/pages/ApprovalQueue'
import VoucherRegister from '@/pages/VoucherRegister'
import VoucherSearch from '@/pages/VoucherSearch'
import SuspenseRegister from '@/pages/SuspenseRegister'
import SuspenseEntry from '@/pages/SuspenseEntry'
import ReceiptInbox from '@/pages/ReceiptInbox'
import { ApprovalProvider, useApprovalCount } from '@/contexts/ApprovalContext'
import RelayCapture from '@/pages/RelayCapture'
import SettleCapture from '@/pages/SettleCapture'
import VoucherEdit from '@/pages/VoucherEdit'
import DayBook from '@/pages/DayBook'
import LedgerStatement from '@/pages/LedgerStatement'
import TrialBalance from '@/pages/TrialBalance'
import PLStatement from '@/pages/PLStatement'
import BalanceSheet from '@/pages/BalanceSheet'
import ReceivablesPayables from '@/pages/ReceivablesPayables'
import GSTReports from '@/pages/GSTReports'
import CashFlow from '@/pages/CashFlow'
import RatioAnalysis from '@/pages/RatioAnalysis'
import ScheduleIII   from '@/pages/ScheduleIII'
import TdsReports    from '@/pages/TdsReports'
import ExceptionReports from '@/pages/ExceptionReports'
import Inventory from '@/pages/Inventory'
import AdminPanel from '@/pages/AdminPanel'
import TallyExport from '@/pages/TallyExport'
import FoodStreamLoader from '@/components/FoodStreamLoader'
import DashboardPage from '@/pages/Dashboard'
import AwaitingPayments from '@/pages/AwaitingPayments'
import SettlementPage from '@/pages/SettlementPage'
import BankReconPage from '@/pages/BankReconPage'
import CompliancePage from '@/pages/CompliancePage'
import { ScanUpload, ScanInbox, ScanDetail } from '@/modules/invoice-scan'

function fmtRole(role: string | null | undefined): string {
  if (!role) return '—'
  return role
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
}

// ── Shared app shell (sidebar + main) ────────────────────────────────────────

function AppShell({ children }: { children: React.ReactNode }) {
  const { user, signOut, setActiveCompany } = useAuth()
  const { pendingCount, paymentsCount } = useApprovalCount()
  const location              = useLocation()
  const [navOpen, setNavOpen] = useState(false)
  const [companyMenuOpen, setCompanyMenuOpen] = useState(false)

  const pathGroupKey = (p: string) => {
    if (['/ledgers','/vouchers','/suspense','/invoices','/receipts'].some(r => p === r || p.startsWith(r + '/'))) return 'books'
    if (p.startsWith('/approvals') || p.startsWith('/payments')) return 'workflow'
    if (p.startsWith('/settlement') || p.startsWith('/bank-recon')) return 'recon'
    if (p.startsWith('/compliance') || p === '/reports/gst' || p === '/reports/tds' || p === '/reports/schedule-iii') return 'compliance'
    if (p.startsWith('/inventory')) return 'inventory'
    if (p.startsWith('/reports/')) return 'reports'
    if (p.startsWith('/admin') || p.startsWith('/tally-export')) return 'admin'
    return null
  }

  const [groupOpen, setGroupOpen] = useState(() => {
    const active = pathGroupKey(location.pathname)
    return { books: active === 'books', workflow: active === 'workflow', recon: active === 'recon', compliance: active === 'compliance', inventory: active === 'inventory', reports: active === 'reports', admin: active === 'admin' }
  })

  // Auto-expand the group containing the newly active route
  useEffect(() => {
    const key = pathGroupKey(location.pathname)
    if (key) setGroupOpen(prev => prev[key as keyof typeof prev] ? prev : { ...prev, [key]: true })
  }, [location.pathname])

  const toggleGroup = (key: keyof typeof groupOpen) =>
    setGroupOpen(prev => ({ ...prev, [key]: !prev[key] }))
  const desktopCompanyMenuRef = useRef<HTMLDivElement | null>(null)
  const mobileCompanyMenuRef = useRef<HTMLDivElement | null>(null)

  // Close sidebar on navigation (mobile)
  useEffect(() => { setNavOpen(false) }, [location.pathname])

  const REPORT_ITEMS = [
    { to: '/reports/day-book',             label: 'Day Book'             },
    { to: '/reports/ledger',               label: 'Ledger Statement'     },
    { to: '/reports/trial-balance',        label: 'Trial Balance'        },
    { to: '/reports/pl',                   label: 'P&L Statement'        },
    { to: '/reports/balance-sheet',        label: 'Balance Sheet'        },
    { to: '/reports/receivables-payables', label: 'Receivables/Payables' },
    { to: '/reports/cash-flow',            label: 'Cash Flow'            },
    { to: '/reports/ratios',               label: 'Ratio Analysis'       },
    { to: '/reports/exceptions',           label: 'Exception Reports'    },
  ]

  const canViewReports =
    user?.profile.is_super_admin ||
    (user?.activeRole !== null &&
     ['admin', 'accounts', 'auditor'].includes(user?.activeRole ?? ''))

  const availableCompanies = useMemo(() => {
    if (!user) return []
    const unique = new Map<string, Exclude<(typeof user.companyUsers)[number]['company'], undefined>>()
    user.companyUsers.forEach((cu) => {
      if (!cu.company) return
      if (!unique.has(cu.company.id)) {
        unique.set(cu.company.id, cu.company)
      }
    })
    return Array.from(unique.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [user])

  const canSwitchCompany =
    !!user &&
    availableCompanies.length > 1 &&
    (
      user.profile.is_super_admin ||
      ['admin', 'accounts'].includes(user.activeRole ?? '')
    )

  useEffect(() => {
    setCompanyMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!companyMenuOpen) return
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      const insideDesktop = !!desktopCompanyMenuRef.current?.contains(target)
      const insideMobile = !!mobileCompanyMenuRef.current?.contains(target)
      if (!insideDesktop && !insideMobile) {
        setCompanyMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [companyMenuOpen])

  const activePerson = user?.profile.full_name?.trim() || user?.email || '—'
  const activeRole = user?.profile.is_super_admin ? 'super_admin' : (user?.activeRole ?? null)
  const activeCompany =
    user?.activeCompany?.name ||
    user?.activeCompany?.code ||
    '—'

  return (
    <div className={css.shell}>
      {/* Mobile backdrop */}
      {navOpen && <div className={css.backdrop} onClick={() => setNavOpen(false)} />}

      {/* Sidebar */}
      <nav className={`${css.nav}${navOpen ? ` ${css.navOpen}` : ''}`}>
        {/* Logo + close */}
        <div className={css.navHead}>
          <img src="/Logo_3D.png" alt="Pramaana" style={{ height: '34px', width: 'auto' }} />
          <button className={css.closeBtn} onClick={() => setNavOpen(false)} aria-label="Close menu">
            <X size={18} />
          </button>
        </div>

        {/* Dashboard — no group heading */}
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `${css.link}${isActive ? ` ${css.linkActive}` : ''}`
          }
        >
          <span>Dashboard</span>
        </NavLink>

        {/* BOOKS */}
        <div className={css.navGroup}>
          <button className={css.navGroupToggle} onClick={() => toggleGroup('books')} aria-expanded={groupOpen.books}>
            <span>Books</span>
            <ChevronDown size={13} className={`${css.groupChevron}${groupOpen.books ? ` ${css.groupChevronOpen}` : ''}`} />
          </button>
          <div className={`${css.groupBody}${groupOpen.books ? ` ${css.groupBodyOpen}` : ''}`}>
            <NavLink to="/ledgers" end={false} className={({ isActive }) => `${css.link}${isActive ? ` ${css.linkActive}` : ''}`}><span>Ledgers</span></NavLink>
            <NavLink to="/vouchers" end={false} className={({ isActive }) => `${css.link}${isActive ? ` ${css.linkActive}` : ''}`}><span>Vouchers</span></NavLink>
            <NavLink to="/vouchers" end className={({ isActive }) => `${css.subLink}${isActive ? ` ${css.subLinkActive}` : ''}`}>Register</NavLink>
            <NavLink to="/vouchers/search" end={false} className={({ isActive }) => `${css.subLink}${isActive ? ` ${css.subLinkActive}` : ''}`}>Search</NavLink>
            <NavLink to="/suspense" end={false} className={({ isActive }) => `${css.link}${isActive ? ` ${css.linkActive}` : ''}`}><span>Suspense</span></NavLink>
            <NavLink to="/receipts/inbox" end={false} className={({ isActive }) => `${css.link}${isActive ? ` ${css.linkActive}` : ''}`}><span>Receipts</span></NavLink>
            <NavLink to="/invoices" end={false} className={({ isActive }) => `${css.link}${isActive ? ` ${css.linkActive}` : ''}`}><span>Invoices</span></NavLink>
            <NavLink to="/invoices/scan" end className={({ isActive }) => `${css.subLink}${isActive ? ` ${css.subLinkActive}` : ''}`}>Scan</NavLink>
            <NavLink to="/invoices/inbox" end={false} className={({ isActive }) => `${css.subLink}${isActive ? ` ${css.subLinkActive}` : ''}`}>Inbox</NavLink>
          </div>
        </div>

        {/* WORKFLOW */}
        <div className={css.navGroup}>
          <button className={css.navGroupToggle} onClick={() => toggleGroup('workflow')} aria-expanded={groupOpen.workflow}>
            <span>Workflow</span>
            <ChevronDown size={13} className={`${css.groupChevron}${groupOpen.workflow ? ` ${css.groupChevronOpen}` : ''}`} />
          </button>
          <div className={`${css.groupBody}${groupOpen.workflow ? ` ${css.groupBodyOpen}` : ''}`}>
            <NavLink to="/approvals" end={false} className={({ isActive }) => `${css.link}${isActive ? ` ${css.linkActive}` : ''}`}>
              <span>Approvals</span>
              {pendingCount > 0 && <span className={css.badge}>{pendingCount}</span>}
            </NavLink>
            <NavLink to="/payments" end={false} className={({ isActive }) => `${css.link}${isActive ? ` ${css.linkActive}` : ''}`}>
              <span>Payments</span>
              {paymentsCount > 0 && <span className={css.badge}>{paymentsCount}</span>}
            </NavLink>
          </div>
        </div>

        {/* RECONCILIATION */}
        <div className={css.navGroup}>
          <button className={css.navGroupToggle} onClick={() => toggleGroup('recon')} aria-expanded={groupOpen.recon}>
            <span>Reconciliation</span>
            <ChevronDown size={13} className={`${css.groupChevron}${groupOpen.recon ? ` ${css.groupChevronOpen}` : ''}`} />
          </button>
          <div className={`${css.groupBody}${groupOpen.recon ? ` ${css.groupBodyOpen}` : ''}`}>
            <NavLink to="/settlement" end={false} className={({ isActive }) => `${css.link}${isActive ? ` ${css.linkActive}` : ''}`}><span>Settlement</span></NavLink>
            <NavLink to="/bank-recon" end={false} className={({ isActive }) => `${css.link}${isActive ? ` ${css.linkActive}` : ''}`}><span>Bank Recon</span></NavLink>
          </div>
        </div>

        {/* COMPLIANCE */}
        {canViewReports && (
          <div className={css.navGroup}>
            <button className={css.navGroupToggle} onClick={() => toggleGroup('compliance')} aria-expanded={groupOpen.compliance}>
              <span>Compliance</span>
              <ChevronDown size={13} className={`${css.groupChevron}${groupOpen.compliance ? ` ${css.groupChevronOpen}` : ''}`} />
            </button>
            <div className={`${css.groupBody}${groupOpen.compliance ? ` ${css.groupBodyOpen}` : ''}`}>
              <NavLink to="/compliance" end className={({ isActive }) => `${css.reportLink}${isActive ? ` ${css.reportLinkActive}` : ''}`}>Calendar</NavLink>
              <NavLink to="/reports/gst" end={false} className={({ isActive }) => `${css.reportLink}${isActive ? ` ${css.reportLinkActive}` : ''}`}>GST Reports</NavLink>
              <NavLink to="/reports/tds" end={false} className={({ isActive }) => `${css.reportLink}${isActive ? ` ${css.reportLinkActive}` : ''}`}>TDS Reports</NavLink>
              <NavLink to="/reports/schedule-iii" end={false} className={({ isActive }) => `${css.reportLink}${isActive ? ` ${css.reportLinkActive}` : ''}`}>Schedule III</NavLink>
            </div>
          </div>
        )}

        {/* INVENTORY */}
        <div className={css.navGroup}>
          <button className={css.navGroupToggle} onClick={() => toggleGroup('inventory')} aria-expanded={groupOpen.inventory}>
            <span>Inventory</span>
            <ChevronDown size={13} className={`${css.groupChevron}${groupOpen.inventory ? ` ${css.groupChevronOpen}` : ''}`} />
          </button>
          <div className={`${css.groupBody}${groupOpen.inventory ? ` ${css.groupBodyOpen}` : ''}`}>
            <NavLink to="/inventory" end={false} className={({ isActive }) => `${css.link}${isActive ? ` ${css.linkActive}` : ''}`}><span>Inventory</span></NavLink>
          </div>
        </div>

        {/* REPORTS */}
        {canViewReports && (
          <div className={css.navGroup}>
            <button className={css.navGroupToggle} onClick={() => toggleGroup('reports')} aria-expanded={groupOpen.reports}>
              <span>Reports</span>
              <ChevronDown size={13} className={`${css.groupChevron}${groupOpen.reports ? ` ${css.groupChevronOpen}` : ''}`} />
            </button>
            <div className={`${css.groupBody}${groupOpen.reports ? ` ${css.groupBodyOpen}` : ''}`}>
              {REPORT_ITEMS.map(({ to, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={false}
                  className={({ isActive }) => `${css.reportLink}${isActive ? ` ${css.reportLinkActive}` : ''}`}
                >
                  {label}
                </NavLink>
              ))}
            </div>
          </div>
        )}

        {/* ADMIN — super admin only */}
        {user?.profile.is_super_admin && (
          <div className={css.navGroup}>
            <button className={css.navGroupToggle} onClick={() => toggleGroup('admin')} aria-expanded={groupOpen.admin}>
              <span>Admin</span>
              <ChevronDown size={13} className={`${css.groupChevron}${groupOpen.admin ? ` ${css.groupChevronOpen}` : ''}`} />
            </button>
            <div className={`${css.groupBody}${groupOpen.admin ? ` ${css.groupBodyOpen}` : ''}`}>
              <NavLink to="/admin" end={false} className={({ isActive }) => `${css.adminLink}${isActive ? ` ${css.adminLinkActive}` : ''}`}>Admin Panel</NavLink>
              <NavLink to="/tally-export" end={false} className={({ isActive }) => `${css.adminLink}${isActive ? ` ${css.adminLinkActive}` : ''}`}>Tally Export</NavLink>
            </div>
          </div>
        )}

        {/* Footer: Sign out */}
        <div className={css.navFooter}>
          <button className={css.signOut} onClick={signOut}>Sign out</button>
        </div>
      </nav>

      {/* Page content */}
      <div className={css.mainWrap}>
        {/* Desktop global header */}
        <header className={css.globalHeader}>
          <div className={css.globalHeaderMeta}>
            <span className={css.metaPill}><strong>Login</strong>{activePerson}</span>
            <span className={css.metaPill}><strong>Role</strong>{fmtRole(activeRole)}</span>
            {canSwitchCompany ? (
              <div className={css.companySelectWrap} ref={desktopCompanyMenuRef}>
                <button
                  type="button"
                  className={`${css.metaPill} ${css.metaPillBtn}`}
                  onClick={() => setCompanyMenuOpen(o => !o)}
                  aria-haspopup="menu"
                  aria-expanded={companyMenuOpen}
                >
                  <strong>Company</strong>
                  <span className={css.metaPillValue}>{activeCompany}</span>
                  <ChevronDown size={14} className={`${css.metaChevron} ${companyMenuOpen ? css.metaChevronOpen : ''}`} />
                </button>
                {companyMenuOpen && (
                  <div className={css.companyMenu} role="menu">
                    {availableCompanies.map((company) => {
                      const isActive = company.id === user?.activeCompany?.id
                      return (
                        <button
                          key={company.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isActive}
                          className={`${css.companyMenuItem} ${isActive ? css.companyMenuItemActive : ''}`}
                          onClick={() => {
                            setActiveCompany(company)
                            setCompanyMenuOpen(false)
                          }}
                        >
                          <span>{company.name}</span>
                          <span className={css.companyCode}>{company.code}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            ) : (
              <span className={css.metaPill}><strong>Company</strong>{activeCompany}</span>
            )}
          </div>
        </header>

        {/* Mobile topbar */}
        <div className={css.topbar}>
          <button
            className={css.menuBtn}
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={18} />
          </button>
          <img src="/Logo_3D.png" alt="Pramaana" style={{ height: '28px', width: 'auto' }} />
          <div className={css.topbarMeta}>
            <span className={css.topbarMetaLine}>{activePerson}</span>
            <span className={css.topbarMetaLine}>{fmtRole(activeRole)}</span>
            {canSwitchCompany ? (
              <div className={`${css.companySelectWrap} ${css.mobileCompanySelectWrap}`} ref={mobileCompanyMenuRef}>
                <button
                  type="button"
                  className={`${css.metaPill} ${css.metaPillBtn} ${css.mobileMetaPillBtn}`}
                  onClick={() => setCompanyMenuOpen(o => !o)}
                  aria-haspopup="menu"
                  aria-expanded={companyMenuOpen}
                >
                  <strong>Company</strong>
                  <span className={css.metaPillValue}>{activeCompany}</span>
                  <ChevronDown size={14} className={`${css.metaChevron} ${companyMenuOpen ? css.metaChevronOpen : ''}`} />
                </button>
                {companyMenuOpen && (
                  <div className={`${css.companyMenu} ${css.mobileCompanyMenu}`} role="menu">
                    {availableCompanies.map((company) => {
                      const isActive = company.id === user?.activeCompany?.id
                      return (
                        <button
                          key={company.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isActive}
                          className={`${css.companyMenuItem} ${isActive ? css.companyMenuItemActive : ''}`}
                          onClick={() => {
                            setActiveCompany(company)
                            setCompanyMenuOpen(false)
                          }}
                        >
                          <span>{company.name}</span>
                          <span className={css.companyCode}>{company.code}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            ) : (
              <span className={css.topbarMetaLine}>{activeCompany}</span>
            )}
          </div>
        </div>
        <main className={css.main}>{children}</main>
      </div>
    </div>
  )
}

// Dashboard — wraps in AppShell since AppShell is defined here
function Dashboard() {
  return <AppShell><DashboardPage /></AppShell>
}

// ── Route guard ───────────────────────────────────────────────────────────────

const LEDGER_ROLES   = new Set(['admin', 'accounts', 'auditor'])
const VOUCHER_ROLES  = new Set(['admin', 'accounts'])

function LedgersGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && LEDGER_ROLES.has(user.activeRole))
  if (!allowed) return <Navigate to="/" replace />
  return <AppShell><Ledgers /></AppShell>
}

function VoucherEntryGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && VOUCHER_ROLES.has(user.activeRole))
  if (!allowed) return <Navigate to="/" replace />
  return <AppShell><VoucherEntry /></AppShell>
}

const APPROVAL_ROLES = new Set(['admin', 'accounts', 'auditor'])

function VoucherRegisterGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  return <AppShell><VoucherRegister /></AppShell>
}

function VoucherSearchGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  return <AppShell><VoucherSearch /></AppShell>
}

function SuspenseRegisterGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  return <AppShell><SuspenseRegister /></AppShell>
}

function SuspenseEntryGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && VOUCHER_ROLES.has(user.activeRole))
  if (!allowed) return <Navigate to="/suspense" replace />
  return <AppShell><SuspenseEntry /></AppShell>
}

function VoucherEditGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && VOUCHER_ROLES.has(user.activeRole))
  if (!allowed) return <Navigate to="/vouchers" replace />
  return <AppShell><VoucherEdit /></AppShell>
}

function ApprovalQueueGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && APPROVAL_ROLES.has(user.activeRole))
  if (!allowed) return <Navigate to="/" replace />
  return <AppShell><ApprovalQueue /></AppShell>
}

const INVENTORY_ROLES = new Set(['admin', 'accounts', 'auditor'])

function InventoryGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && INVENTORY_ROLES.has(user.activeRole))
  if (!allowed) return <Navigate to="/" replace />
  return <AppShell><Inventory /></AppShell>
}

function AwaitingPaymentsGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && ['admin', 'accounts'].includes(user.activeRole))
  if (!allowed) return <Navigate to="/" replace />
  return <AppShell><AwaitingPayments /></AppShell>
}

function SettlementGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && VOUCHER_ROLES.has(user.activeRole))
  if (!allowed) return <Navigate to="/" replace />
  return <AppShell><SettlementPage /></AppShell>
}

const BANK_RECON_ROLES = new Set(['admin','accounts','auditor'])

function BankReconGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && BANK_RECON_ROLES.has(user.activeRole))
  if (!allowed) return <Navigate to="/" replace />
  return <AppShell><BankReconPage /></AppShell>
}

function AdminGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (!user.profile.is_super_admin) return <Navigate to="/" replace />
  return <AppShell><AdminPanel /></AppShell>
}

const INVOICE_ROLES = new Set(['admin', 'accounts'])

function InvoiceScanUploadGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && INVOICE_ROLES.has(user.activeRole))
  if (!allowed) return <Navigate to="/" replace />
  return <AppShell><ScanUpload /></AppShell>
}

function InvoiceScanInboxGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && LEDGER_ROLES.has(user.activeRole))
  if (!allowed) return <Navigate to="/" replace />
  return <AppShell><ScanInbox /></AppShell>
}

function InvoiceScanDetailGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && LEDGER_ROLES.has(user.activeRole))
  if (!allowed) return <Navigate to="/" replace />
  return <AppShell><ScanDetail /></AppShell>
}

const REPORT_ROLES = new Set(['admin', 'accounts', 'auditor'])

function ReportGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && REPORT_ROLES.has(user.activeRole))
  if (!allowed) return <Navigate to="/" replace />
  return <AppShell>{children}</AppShell>
}

function AppRoutes() {
  const { user, loading, needsPasswordSet } = useAuth()

  if (loading) {
    return <FoodStreamLoader label="Loading Pramaana" />
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login"          element={<Login />} />
        <Route path="/set-password"   element={<SetPassword />} />
        <Route path="/relay"          element={<RelayCapture />} />
        <Route path="/settle/:token"  element={<SettleCapture />} />
        <Route path="*"               element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  // User is logged in but must set a password (invite or recovery link)
  if (needsPasswordSet) {
    return (
      <Routes>
        <Route path="/set-password" element={<SetPassword />} />
        <Route path="*"             element={<Navigate to="/set-password" replace />} />
      </Routes>
    )
  }

  // User is logged in but hasn't chosen a company yet
  if (!user.activeCompany) {
    return (
      <Routes>
        <Route path="/select-company" element={<CompanySelector />} />
        <Route path="/relay"          element={<RelayCapture />} />
        <Route path="/settle/:token"  element={<SettleCapture />} />
        <Route path="*"               element={<Navigate to="/select-company" replace />} />
      </Routes>
    )
  }

  // Fully authenticated with active company
  return (
    <ApprovalProvider companyId={user.activeCompany.id}>
      <Routes>
        <Route path="/"            element={<Dashboard />} />
        <Route path="/relay"        element={<RelayCapture />} />
        <Route path="/settle/:token" element={<SettleCapture />} />
        <Route path="/ledgers"     element={<LedgersGuard />} />
        <Route path="/vouchers"            element={<VoucherRegisterGuard />} />
        <Route path="/vouchers/search"      element={<VoucherSearchGuard />} />
        <Route path="/vouchers/new"         element={<VoucherEntryGuard />} />
        <Route path="/vouchers/:id/edit"    element={<VoucherEditGuard />} />
        <Route path="/suspense"       element={<SuspenseRegisterGuard />} />
        <Route path="/suspense/new"   element={<SuspenseEntryGuard />} />
        <Route path="/receipts/inbox" element={<ReceiptInbox />} />
        <Route path="/approvals"      element={<ApprovalQueueGuard />} />
        <Route path="/payments"        element={<AwaitingPaymentsGuard />} />
        <Route path="/settlement"       element={<SettlementGuard />} />
        <Route path="/bank-recon"         element={<BankReconGuard />} />
        <Route path="/bank-recon/:statementId" element={<BankReconGuard />} />
        <Route path="/compliance"           element={<ReportGuard><CompliancePage /></ReportGuard>} />
        <Route path="/inventory"      element={<InventoryGuard />} />
        <Route path="/invoices/scan"              element={<InvoiceScanUploadGuard />} />
        <Route path="/invoices/inbox"             element={<InvoiceScanInboxGuard />} />
        <Route path="/invoices/inbox/:id"         element={<InvoiceScanDetailGuard />} />
        <Route path="/invoices"                   element={<Navigate to="/invoices/inbox" replace />} />
        <Route path="/admin"          element={<AdminGuard />} />
        <Route path="/tally-export"   element={<TallyExport />} />
        <Route path="/reports/day-book"             element={<ReportGuard><DayBook /></ReportGuard>} />
        <Route path="/reports/ledger"               element={<ReportGuard><LedgerStatement /></ReportGuard>} />
        <Route path="/reports/trial-balance"        element={<ReportGuard><TrialBalance /></ReportGuard>} />
        <Route path="/reports/pl"                   element={<ReportGuard><PLStatement /></ReportGuard>} />
        <Route path="/reports/balance-sheet"        element={<ReportGuard><BalanceSheet /></ReportGuard>} />
        <Route path="/reports/receivables-payables" element={<ReportGuard><ReceivablesPayables /></ReportGuard>} />
        <Route path="/reports/cash-flow"            element={<ReportGuard><CashFlow /></ReportGuard>} />
        <Route path="/reports/gst"                  element={<ReportGuard><GSTReports /></ReportGuard>} />
        <Route path="/reports/ratios"               element={<ReportGuard><RatioAnalysis /></ReportGuard>} />
        <Route path="/reports/exceptions"           element={<ReportGuard><ExceptionReports /></ReportGuard>} />        <Route path="/reports/schedule-iii"          element={<ReportGuard><ScheduleIII /></ReportGuard>} />
        <Route path="/reports/tds"                   element={<ReportGuard><TdsReports /></ReportGuard>} />        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="/select-company" element={<Navigate to="/" replace />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ApprovalProvider>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
        <Toaster
          position="top-right"
          richColors
          theme="dark"
          toastOptions={{ duration: 4000 }}
        />
      </AuthProvider>
    </BrowserRouter>
  )
}
