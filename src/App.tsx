import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import Login from '@/pages/Login'
import CompanySelector from '@/pages/CompanySelector'
import Ledgers from '@/pages/Ledgers'

// ── Shared app shell (sidebar + main) ────────────────────────────────────────

function AppShell({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth()
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>
      {/* Temp sidebar nav — replaced by proper layout component in Screen 3 */}
      <nav style={{
        width: 200, background: 'var(--surface)', borderRight: '1px solid var(--border)',
        padding: '1.5rem 0', display: 'flex', flexDirection: 'column', gap: '0.25rem',
        flexShrink: 0,
      }}>
        <div style={{ padding: '0 1rem 1rem' }}>
          <img src="/Logo_3D.png" alt="Pramaana" style={{ height: '36px', width: 'auto' }} />
        </div>
        {[
          { to: '/',        label: 'Dashboard' },
          { to: '/ledgers', label: 'Ledgers' },
        ].map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            end
            style={({ isActive }) => ({
              display: 'block', padding: '0.5rem 1rem',
              color: isActive ? 'var(--teal)' : 'var(--text-muted)',
              background: isActive ? 'var(--teal-light)' : 'none',
              borderRadius: '6px', margin: '0 0.5rem',
              fontSize: '0.875rem', fontWeight: isActive ? 600 : 400,
              textDecoration: 'none',
            })}
          >
            {label}
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
      </nav>
      <main style={{ flex: 1, overflow: 'auto' }}>{children}</main>
    </div>
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

const LEDGER_ROLES = new Set(['admin', 'accounts', 'auditor'])

function LedgersGuard() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  const allowed =
    user.profile.is_super_admin ||
    (user.activeRole !== null && LEDGER_ROLES.has(user.activeRole))
  if (!allowed) return <Navigate to="/" replace />
  return <AppShell><Ledgers /></AppShell>
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
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  // User is logged in but hasn't chosen a company yet
  if (!user.activeCompany) {
    return (
      <Routes>
        <Route path="/select-company" element={<CompanySelector />} />
        <Route path="*" element={<Navigate to="/select-company" replace />} />
      </Routes>
    )
  }

  // Fully authenticated with active company
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/ledgers" element={<LedgersGuard />} />
      <Route path="/dashboard" element={<Navigate to="/" replace />} />
      <Route path="/select-company" element={<Navigate to="/" replace />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
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
