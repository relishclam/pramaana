import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { ChevronDown, BarChart2, X, Menu } from 'lucide-react'
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
import ExceptionReports from '@/pages/ExceptionReports'
import Inventory from '@/pages/Inventory'
import AdminPanel from '@/pages/AdminPanel'
import DashboardPage from '@/pages/Dashboard'
import { ScanUpload, ScanInbox, ScanDetail } from '@/modules/invoice-scan'

// ── Shared app shell (sidebar + main) ────────────────────────────────────────

function AppShell({ children }: { children: React.ReactNode }) {
  const { user, signOut }     = useAuth()
  const { pendingCount }      = useApprovalCount()
  const location              = useLocation()
  const [navOpen, setNavOpen] = useState(false)

  const onReport = location.pathname.startsWith('/reports/')
  const [reportsOpen, setReportsOpen] = useState(onReport)

  // Auto-expand reports when navigating to a report page
  useEffect(() => {
    if (location.pathname.startsWith('/reports/')) setReportsOpen(true)
  }, [location.pathname])

  // Close sidebar on navigation (mobile)
  useEffect(() => { setNavOpen(false) }, [location.pathname])

  const NAV_ITEMS = [
    { to: '/',          label: 'Dashboard', end: true,  badge: 0            },
    { to: '/ledgers',   label: 'Ledgers',   end: false, badge: 0            },
    { to: '/vouchers',  label: 'Vouchers',  end: false, badge: 0            },
    { to: '/suspense',  label: 'Suspense',  end: false, badge: 0            },
    { to: '/approvals', label: 'Approvals', end: false, badge: pendingCount },
    { to: '/invoices',  label: 'Invoices',  end: false, badge: 0            },
    { to: '/inventory', label: 'Inventory', end: false, badge: 0            },
  ]

  const INVOICE_SUB_ITEMS = [
    { to: '/invoices/scan',  label: 'Scan',  end: true  },
    { to: '/invoices/inbox', label: 'Inbox', end: false },
  ]

  const VOUCHER_SUB_ITEMS = [
    { to: '/vouchers',        label: 'Register', end: true  },
    { to: '/vouchers/search', label: 'Search',   end: false },
  ]

  const REPORT_ITEMS = [
    { to: '/reports/day-book',             label: 'Day Book'             },
    { to: '/reports/ledger',               label: 'Ledger Statement'     },
    { to: '/reports/trial-balance',        label: 'Trial Balance'        },
    { to: '/reports/pl',                   label: 'P&L Statement'        },
    { to: '/reports/balance-sheet',        label: 'Balance Sheet'        },
    { to: '/reports/receivables-payables', label: 'Receivables/Payables' },
    { to: '/reports/cash-flow',            label: 'Cash Flow'            },
    { to: '/reports/gst',                  label: 'GST Reports'          },
    { to: '/reports/ratios',               label: 'Ratio Analysis'       },
    { to: '/reports/exceptions',           label: 'Exception Reports'    },
  ]

  const canViewReports =
    user?.profile.is_super_admin ||
    (user?.activeRole !== null &&
     ['admin', 'accounts', 'auditor'].includes(user?.activeRole ?? ''))

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

        {/* Main nav items */}
        {NAV_ITEMS.map(({ to, label, end, badge }) => {
          if (to === '/invoices') {
            return (
              <div key={to}>
                <NavLink
                  to={to}
                  end={false}
                  className={({ isActive }) =>
                    `${css.link}${isActive ? ` ${css.linkActive}` : ''}`
                  }
                >
                  <span>{label}</span>
                </NavLink>
                {INVOICE_SUB_ITEMS.map(({ to: s, label: sl, end: se }) => (
                  <NavLink
                    key={s}
                    to={s}
                    end={se}
                    className={({ isActive }) =>
                      `${css.subLink}${isActive ? ` ${css.subLinkActive}` : ''}`
                    }
                  >
                    {sl}
                  </NavLink>
                ))}
              </div>
            )
          }
          if (to === '/vouchers') {
            return (
              <div key={to}>
                <NavLink
                  to={to}
                  end={false}
                  className={({ isActive }) =>
                    `${css.link}${isActive ? ` ${css.linkActive}` : ''}`
                  }
                >
                  <span>{label}</span>
                </NavLink>
                {VOUCHER_SUB_ITEMS.map(({ to: s, label: sl, end: se }) => (
                  <NavLink
                    key={s}
                    to={s}
                    end={se}
                    className={({ isActive }) =>
                      `${css.subLink}${isActive ? ` ${css.subLinkActive}` : ''}`
                    }
                  >
                    {sl}
                  </NavLink>
                ))}
              </div>
            )
          }
          return (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `${css.link}${isActive ? ` ${css.linkActive}` : ''}`
              }
            >
              <span>{label}</span>
              {badge > 0 && <span className={css.badge}>{badge}</span>}
            </NavLink>
          )
        })}

        {/* Reports — collapsible */}
        {canViewReports && (
          <>
            <button
              className={css.sectionToggle}
              onClick={() => setReportsOpen(o => !o)}
              aria-expanded={reportsOpen}
            >
              <span className={css.sectionLabel}>
                <BarChart2 size={12} />
                Reports
              </span>
              <ChevronDown
                size={14}
                className={`${css.chevron}${reportsOpen ? ` ${css.chevronOpen}` : ''}`}
              />
            </button>
            <div className={`${css.sectionBody}${reportsOpen ? ` ${css.sectionBodyOpen}` : ''}`}>
              {REPORT_ITEMS.map(({ to, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={false}
                  className={({ isActive }) =>
                    `${css.reportLink}${isActive ? ` ${css.reportLinkActive}` : ''}`
                  }
                >
                  {label}
                </NavLink>
              ))}
            </div>
          </>
        )}

        {/* Footer: Admin + Sign out */}
        <div className={css.navFooter}>
          {user?.profile.is_super_admin && (
            <NavLink
              to="/admin"
              end={false}
              className={({ isActive }) =>
                `${css.adminLink}${isActive ? ` ${css.adminLinkActive}` : ''}`
              }
            >
              ⚙ Admin Panel
            </NavLink>
          )}
          <button className={css.signOut} onClick={signOut}>Sign out</button>
        </div>
      </nav>

      {/* Page content */}
      <div className={css.mainWrap}>
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
          <span className={css.topbarCompany}>{user?.activeCompany?.name}</span>
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
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: 'var(--bg)',
      }}>
        <span style={{
          width: 32, height: 32,
          border: '3px solid var(--border)',
          borderTopColor: 'var(--teal)',
          borderRadius: '50%',
          animation: 'spin 0.7s linear infinite',
          display: 'inline-block',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
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
        <Route path="/approvals"      element={<ApprovalQueueGuard />} />
        <Route path="/inventory"      element={<InventoryGuard />} />
        <Route path="/invoices/scan"              element={<InvoiceScanUploadGuard />} />
        <Route path="/invoices/inbox"             element={<InvoiceScanInboxGuard />} />
        <Route path="/invoices/inbox/:id"         element={<InvoiceScanDetailGuard />} />
        <Route path="/invoices"                   element={<Navigate to="/invoices/inbox" replace />} />
        <Route path="/admin"          element={<AdminGuard />} />
        <Route path="/reports/day-book"             element={<ReportGuard><DayBook /></ReportGuard>} />
        <Route path="/reports/ledger"               element={<ReportGuard><LedgerStatement /></ReportGuard>} />
        <Route path="/reports/trial-balance"        element={<ReportGuard><TrialBalance /></ReportGuard>} />
        <Route path="/reports/pl"                   element={<ReportGuard><PLStatement /></ReportGuard>} />
        <Route path="/reports/balance-sheet"        element={<ReportGuard><BalanceSheet /></ReportGuard>} />
        <Route path="/reports/receivables-payables" element={<ReportGuard><ReceivablesPayables /></ReportGuard>} />
        <Route path="/reports/cash-flow"            element={<ReportGuard><CashFlow /></ReportGuard>} />
        <Route path="/reports/gst"                  element={<ReportGuard><GSTReports /></ReportGuard>} />
        <Route path="/reports/ratios"               element={<ReportGuard><RatioAnalysis /></ReportGuard>} />
        <Route path="/reports/exceptions"           element={<ReportGuard><ExceptionReports /></ReportGuard>} />
        <Route path="/dashboard" element={<Navigate to="/" replace />} />
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
