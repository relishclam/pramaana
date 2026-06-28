// ─── Registry schema types ────────────────────────────────────────────────────

export interface Profile {
  id: string
  email: string | null
  full_name: string | null
  mobile: string | null           // direct mobile — set in AdminPanel or synced from entity
  mobile_verified: boolean
  entity_id: string | null        // FK → registry.entities — links this user to a business contact
  is_super_admin: boolean
  is_active: boolean
  created_at: string
}

export interface Company {
  id: string
  code: string        // 'RHHF' | 'RFPL'
  name: string
  gstin: string | null
  is_active: boolean
}

export type CompanyUserRole = 'admin' | 'accounts' | 'auditor' | 'hr' | 'operations' | 'viewer'

export interface CompanyUser {
  id: string
  user_id: string
  company_id: string
  role: CompanyUserRole
  company?: Company
}

// ─── Auth context types ───────────────────────────────────────────────────────

export interface AuthUser {
  id: string
  email: string
  profile: Profile
  companyUsers: CompanyUser[]     // all active company memberships
  activeCompany: Company | null
  activeRole: CompanyUserRole | null
}
