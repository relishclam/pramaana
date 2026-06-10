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
import SuspenseRegister from '@/pages/SuspenseRegister'
import SuspenseEntry from '@/pages/SuspenseEntry'
import { ApprovalProvider, useApprovalCount } from '@/contexts/ApprovalContext'
import RelayCapture from '@/pages/RelayCapture'
import SettleCapture from '@/pages/SettleCapture'
import VoucherEdit from '@/pages/VoucherEdit'

// ── Shared app shell (sidebar + main) ────────────────────────────────────────

function AppShell({ children }: { children: React.ReactNode }) {
  const { user, signOut }    = useAuth()
  const { pendingCount }     = useApprovalCount()
  const [navOpen, setNavOpen] = useState(false)

  // Close sidebar on route change (mobile)
  useEffect(() => { setNavOpen(false) }, [children])

  const NAV_ITEMS = [
    { to: '/',             label: 'Dashboard', end: true,  badge: 0            },
    { to: '/ledgers',      label: 'Ledgers',   end: false, badge: 0            },
    { to: '/vouchers',   label: 'Vouchers',  end: false, badge: 0            },
    { to: '/suspense',   label: 'Suspense',  end: false, badge: 0            },
    { to: '/approvals',  label: 'Approvals', end: false, badge: pendingCount },
  ]

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
      {NAV_ITEMS.map(({ to, label, end, badge }) => (
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
      ))}
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
        <Route path="/vouchers/new"         element={<VoucherEntryGuard />} />
        <Route path="/vouchers/:id/edit"    element={<VoucherEditGuard />} />
        <Route path="/suspense"       element={<SuspenseRegisterGuard />} />
        <Route path="/suspense/new"   element={<SuspenseEntryGuard />} />
        <Route path="/approvals"      element={<ApprovalQueueGuard />} />
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
