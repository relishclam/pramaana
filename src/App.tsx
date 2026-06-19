import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { Toaster } from 'sonner'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import Login from '@/pages/Login'
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

// ── Shared app shell (sidebar + main) ────────────────────────────────────────

function AppShell({ children }: { children: React.ReactNode }) {
  const { user, signOut }    = useAuth()
  const { pendingCount }     = useApprovalCount()
  const [navOpen, setNavOpen] = useState(false)

  // Close sidebar on route change (mobile)
  useEffect(() => { setNavOpen(false) }, [children])

  const NAV_ITEMS = [
    { to: '/',           label: 'Dashboard', end: true,  badge: 0            },
    { to: '/ledgers',    label: 'Ledgers',   end: false, badge: 0            },
    { to: '/vouchers',   label: 'Vouchers',  end: false, badge: 0            },
    { to: '/suspense',   label: 'Suspense',  end: false, badge: 0            },
    { to: '/approvals',  label: 'Approvals', end: false, badge: pendingCount },
    { to: '/inventory',  label: 'Inventory',  end: false, badge: 0            },
  ]

  const REPORT_ITEMS = [
    { to: '/reports/day-book',             label: 'Day Book'              },
    { to: '/reports/ledger',               label: 'Ledger Statement'      },
    { to: '/reports/trial-balance',        label: 'Trial Balance'         },
    { to: '/reports/pl',                   label: 'P&L Statement'         },
    { to: '/reports/balance-sheet',        label: 'Balance Sheet'         },
    { to: '/reports/receivables-payables', label: 'Receivables/Payables'  },
    { to: '/reports/cash-flow',            label: 'Cash Flow'             },
    { to: '/reports/gst',                  label: 'GST Reports'           },
    { to: '/reports/ratios',               label: 'Ratio Analysis'        },
    { to: '/reports/exceptions',           label: 'Exception Reports'     },
  ]

  const VOUCHER_SUB_ITEMS = [
    { to: '/vouchers',        label: 'Register', end: true  },
    { to: '/vouchers/search', label: 'Search',   end: false },
  ]

  const canViewReports =
    user?.profile.is_super_admin ||
    (user?.activeRole !== null &&
     ['admin', 'accounts', 'auditor'].includes(user?.activeRole ?? ''))

  const sidebarContent = (
    <>
      <div style={{ padding: '0 1rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <img src="/Logo_3D.png" alt="Pramaana" style={{ height: '36px', width: 'auto' }} />
        {/* Close button — mobile only */}
        <button
          onClick={() => setNavOpen(false)}
          aria-label="Close menu"
          style={{
            display: 'none', background: 'none', border: 'none',
            color: 'var(--text-muted)', cursor: 'pointer', padding: '4px',
            fontSize: '1.25rem', lineHeight: 1,
          }}
          className="nav-close-btn"
        >
          ✕
        </button>
      </div>
      {NAV_ITEMS.map(({ to, label, end, badge }) => {
        // Vouchers gets a sub-menu for Register and Search
        if (to === '/vouchers') {
          return (
            <div key={to}>
              <NavLink
                to={to}
                end={false}
                onClick={() => setNavOpen(false)}
                style={({ isActive }) => ({
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0.5rem 1rem',
                  color: isActive ? 'var(--teal)' : 'var(--text-muted)',
                  background: isActive ? 'var(--teal-light)' : 'none',
                  borderRadius: '6px', margin: '0 0.5rem',
                  fontSize: '0.875rem', fontWeight: isActive ? 600 : 400,
                  textDecoration: 'none',
                })}
              >
                <span>{label}</span>
              </NavLink>
              {VOUCHER_SUB_ITEMS.map(({ to: subTo, label: subLabel, end: subEnd }) => (
                <NavLink
                  key={subTo}
                  to={subTo}
                  end={subEnd}
                  onClick={() => setNavOpen(false)}
                  style={({ isActive }) => ({
                    display: 'block',
                    padding: '0.3125rem 1rem 0.3125rem 2rem',
                    color: isActive ? 'var(--teal)' : 'var(--text-muted)',
                    background: isActive ? 'var(--teal-light)' : 'none',
                    borderRadius: '6px', margin: '0 0.5rem',
                    fontSize: '0.8125rem', fontWeight: isActive ? 600 : 400,
                    textDecoration: 'none',
                  })}
                >
                  {subLabel}
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
            onClick={() => setNavOpen(false)}
            style={({ isActive }) => ({
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '0.5rem 1rem',
              color: isActive ? 'var(--teal)' : 'var(--text-muted)',
              background: isActive ? 'var(--teal-light)' : 'none',
              borderRadius: '6px', margin: '0 0.5rem',
              fontSize: '0.875rem', fontWeight: isActive ? 600 : 400,
              textDecoration: 'none',
            })}
          >
            <span>{label}</span>
            {badge > 0 && (
              <span style={{
                background: 'var(--error)', color: '#fff',
                borderRadius: '10px', padding: '1px 6px',
                fontSize: '0.6875rem', fontWeight: 700, lineHeight: '1.4',
                minWidth: '18px', textAlign: 'center',
              }}>
                {badge}
              </span>
            )}
          </NavLink>
        )
      })}

      {/* Reports section */}
      {canViewReports && (
        <>
          <div style={{
            padding: '0.75rem 1.5rem 0.25rem',
            fontSize: '0.6875rem', fontWeight: 700,
            color: 'var(--text-dim)', letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}>
            Reports
          </div>
          {REPORT_ITEMS.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={false}
              onClick={() => setNavOpen(false)}
              style={({ isActive }) => ({
                display: 'block',
                padding: '0.375rem 1rem 0.375rem 1.5rem',
                color: isActive ? 'var(--teal)' : 'var(--text-muted)',
                background: isActive ? 'var(--teal-light)' : 'none',
                borderRadius: '6px', margin: '0 0.5rem',
                fontSize: '0.8125rem', fontWeight: isActive ? 600 : 400,
                textDecoration: 'none',
              })}
            >
              {label}
            </NavLink>
          ))}
        </>
      )}
      <div style={{ marginTop: 'auto', padding: '0 0.5rem' }}>
        <button
          onClick={signOut}
          style={{
            width: '100%', padding: '0.5rem 1rem', background: 'none',
            border: '1px solid var(--border)', borderRadius: '6px',
            color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8125rem',
            textAlign: 'left',
          }}
        >
          Sign out
        </button>
      </div>
    </>
  )

  return (
    <>
      {/* Scoped CSS for responsive sidebar */}
      <style>{`
        .app-shell { display: flex; min-height: 100vh; background: var(--bg); }
        .app-nav {
          width: 200px; background: var(--surface);
          border-right: 1px solid var(--border);
          padding: 1.5rem 0; display: flex; flex-direction: column;
          gap: 0.25rem; flex-shrink: 0;
        }
        .app-topbar { display: none; }
        @media (max-width: 680px) {
          .app-nav {
            position: fixed; top: 0; left: 0; bottom: 0; z-index: 200;
            transform: translateX(-100%);
            transition: transform 0.25s cubic-bezier(0.4,0,0.2,1);
            box-shadow: 4px 0 24px rgba(0,0,0,0.4);
          }
          .app-nav.open { transform: translateX(0); }
          .app-topbar {
            display: flex; align-items: center; gap: 0.75rem;
            padding: 0.75rem 1rem;
            background: var(--surface); border-bottom: 1px solid var(--border);
            position: sticky; top: 0; z-index: 100;
          }
          .nav-close-btn { display: block !important; }
          .app-backdrop {
            position: fixed; inset: 0; background: rgba(0,0,0,0.5);
            z-index: 199;
          }
        }
      `}</style>

      <div className="app-shell">
        {/* Mobile backdrop */}
        {navOpen && <div className="app-backdrop" onClick={() => setNavOpen(false)} />}

        {/* Sidebar */}
        <nav className={`app-nav${navOpen ? ' open' : ''}`}>
          {sidebarContent}
        </nav>

        {/* Main content */}
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* Mobile top bar */}
          <div className="app-topbar">
            <button
              onClick={() => setNavOpen(true)}
              aria-label="Open menu"
              style={{
                background: 'none', border: '1px solid var(--border)',
                borderRadius: '6px', padding: '6px 10px',
                color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem',
                lineHeight: 1, flexShrink: 0,
              }}
            >
              ☰
            </button>
            <img src="/Logo_3D.png" alt="Pramaana" style={{ height: '28px', width: 'auto' }} />
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
              {user?.activeCompany?.code}
            </span>
          </div>
          <main style={{ flex: 1 }}>{children}</main>
        </div>
      </div>
    </>
  )
}

// Placeholder for dashboard — replaced when Screen 3+ are built
function Dashboard() {
  const { user } = useAuth()
  return (
    <AppShell>
      <div style={{ padding: '2rem', color: 'var(--text)' }}>
        <p>
          Welcome, {user?.profile.full_name ?? user?.email} ·{' '}
          <strong style={{ color: 'var(--gold)' }}>{user?.activeCompany?.name}</strong>
          {user?.profile.is_super_admin && (
            <span style={{ marginLeft: '0.5rem', color: 'var(--teal)', fontSize: '0.75rem' }}>
              super_admin
            </span>
          )}
        </p>
        <p style={{ marginTop: '0.5rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
          Role: {user?.activeRole ?? '—'} · Screen 2 (Ledgers) → use the sidebar.
        </p>
      </div>
    </AppShell>
  )
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
  const { user, loading } = useAuth()

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
        <Route path="/login"        element={<Login />} />
        <Route path="/relay"        element={<RelayCapture />} />
        <Route path="/settle/:token" element={<SettleCapture />} />
        <Route path="*"             element={<Navigate to="/login" replace />} />
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
