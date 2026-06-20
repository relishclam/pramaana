import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { AuthUser, Company, CompanyUser, CompanyUserRole, Profile } from '@/types'

// ─── Context shape ────────────────────────────────────────────────────────────

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  /** Switch the active company (super_admin only, or if user has multiple). */
  setActiveCompany: (company: Company) => void
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// ─── Data fetch helpers ───────────────────────────────────────────────────────

async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .schema('registry')
    .from('profiles')
    .select('id, email, full_name, is_super_admin, is_active, created_at')
    .eq('id', userId)
    .single()

  if (error) {
    console.error('[AuthContext] fetchProfile error:', error.message)
    return null
  }
  return data as Profile
}

async function fetchCompanyUsers(userId: string): Promise<CompanyUser[]> {
  // Step 1: fetch company_users rows
  const { data: cuRows, error: cuError } = await supabase
    .schema('registry')
    .from('company_users')
    .select('id, user_id, company_id, role')
    .eq('user_id', userId)

  if (cuError) {
    console.error('[AuthContext] fetchCompanyUsers error:', cuError.message)
  }

  // Step 2: fetch companies by id array (cross-schema PostgREST FK join is unreliable)
  const companyIds = (cuRows ?? []).map((r: { company_id: string }) => r.company_id)
  const { data: companies, error: coError } = await supabase
    .schema('registry')
    .from('companies')
    .select('id, code, name, gstin, is_active')
    .in('id', companyIds.length > 0 ? companyIds : ['00000000-0000-0000-0000-000000000000'])
    .eq('is_active', true)

  if (coError) {
    console.error('[AuthContext] fetchCompanies error:', coError.message)
  }

  const companyMap = new Map<string, Company>(
    (companies ?? []).map((c: Company) => [c.id, c])
  )

  return (cuRows ?? []).map((cu: { id: string; user_id: string; company_id: string; role: CompanyUserRole }) => ({
    ...cu,
    company: companyMap.get(cu.company_id),
  }))
}

/** For super_admin users who have no company_users rows: fetch all active companies. */
async function fetchAllCompanies(): Promise<Company[]> {
  const { data, error } = await supabase
    .schema('registry')
    .from('companies')
    .select('id, code, name, gstin, is_active')
    .eq('is_active', true)
    .order('code')

  if (error) {
    console.error('[AuthContext] fetchAllCompanies error:', error.message)
    return []
  }
  return (data ?? []) as Company[]
}

async function buildAuthUser(supabaseUser: User): Promise<AuthUser | null> {
  const [profile, companyUsers] = await Promise.all([
    fetchProfile(supabaseUser.id),
    fetchCompanyUsers(supabaseUser.id),
  ])

  if (!profile) return null

  let resolvedCompanyUsers = companyUsers

  // super_admin with no company_users rows: synthesise virtual memberships
  // for all active companies so the company selector works normally.
  if (profile.is_super_admin && companyUsers.length === 0) {
    const allCompanies = await fetchAllCompanies()
    resolvedCompanyUsers = allCompanies.map(c => ({
      id: `sa-${c.id}`,
      user_id: supabaseUser.id,
      company_id: c.id,
      role: 'admin' as CompanyUserRole,   // display role; actual access controlled by is_super_admin
      is_active: true,
      company: c,
    }))
  }

  // Determine initial active company
  let activeCompany: Company | null = null
  let activeRole: CompanyUserRole | null = null

  // Restore the previously selected company from localStorage (survives tab switches / token refreshes)
  const storedCompanyId = localStorage.getItem('pramaana_active_company_id')
  if (storedCompanyId) {
    const cu = resolvedCompanyUsers.find(c => c.company_id === storedCompanyId)
    if (cu?.company) {
      activeCompany = cu.company
      activeRole = profile.is_super_admin ? 'admin' : cu.role
    }
  }

  // Fall back to auto-select when user has exactly one company
  if (!activeCompany && resolvedCompanyUsers.length === 1 && resolvedCompanyUsers[0].company) {
    activeCompany = resolvedCompanyUsers[0].company
    activeRole = profile.is_super_admin ? 'admin' : resolvedCompanyUsers[0].role
  }
  // Multiple companies with no stored preference: CompanySelector will handle it

  return {
    id: supabaseUser.id,
    email: supabaseUser.email ?? '',
    profile,
    companyUsers: resolvedCompanyUsers,
    activeCompany,
    activeRole,
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  const loadUser = useCallback(async (supabaseUser: User) => {
    setLoading(true)
    const authUser = await buildAuthUser(supabaseUser)
    setUser(authUser)
    setLoading(false)
  }, [])

  useEffect(() => {
    // Check existing session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        loadUser(session.user)
      } else {
        setLoading(false)
      }
    })

    // Subscribe to auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session?.user) {
          loadUser(session.user)
        } else {
          setUser(null)
          setLoading(false)
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [loadUser])

  const setActiveCompany = useCallback((company: Company) => {
    localStorage.setItem('pramaana_active_company_id', company.id)
    setUser(prev => {
      if (!prev) return null
      const cu = prev.companyUsers.find(c => c.company_id === company.id)
      return {
        ...prev,
        activeCompany: company,
        activeRole: cu?.role ?? null,
      }
    })
  }, [])

  const signOut = useCallback(async () => {
    localStorage.removeItem('pramaana_active_company_id')
    await supabase.auth.signOut()
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, setActiveCompany, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

/** Returns true if the active user can perform the given minimum role. */
export function useHasRole(minRole: CompanyUserRole | 'super_admin'): boolean {
  const { user } = useAuth()
  if (!user) return false
  if (user.profile.is_super_admin) return true

  const roleRank: Record<CompanyUserRole, number> = {
    admin: 5,
    accounts: 4,
    auditor: 3,
    hr: 2,
    operations: 2,
    viewer: 1,
  }

  if (minRole === 'super_admin') return false
  const userRank = roleRank[user.activeRole ?? 'viewer']
  return userRank >= roleRank[minRole]
}
