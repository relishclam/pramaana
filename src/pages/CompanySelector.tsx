import { Building2, ChevronRight } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import type { Company } from '@/types'
import styles from './CompanySelector.module.css'

/**
 * Shown after login when the user belongs to more than one company.
 * super_admin users who have no company_users rows also land here but
 * can still select a company from the full list (future: fetch all companies).
 */
export default function CompanySelector() {
  const { user, setActiveCompany, signOut } = useAuth()

  if (!user) return null

  const companies: Company[] = user.companyUsers
    .filter(cu => cu.company)
    .map(cu => cu.company as Company)

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <img src="/Logo_3D.png" alt="Pramaana" className={styles.logo} />
          <div>
            <h1 className={styles.title}>Select Company</h1>
            <p className={styles.sub}>
              Welcome, {user.profile.full_name ?? user.email}
            </p>
          </div>
        </div>

        {companies.length === 0 ? (
          <p className={styles.empty}>
            Your account has no active company access. Contact your administrator.
          </p>
        ) : (
          <ul className={styles.list}>
            {companies.map(company => {
              const cu = user.companyUsers.find(c => c.company_id === company.id)
              return (
                <li key={company.id}>
                  <button
                    className={styles.companyBtn}
                    onClick={() => setActiveCompany(company)}
                  >
                    <span className={styles.iconWrap}>
                      <Building2 size={20} />
                    </span>
                    <span className={styles.info}>
                      <span className={styles.companyName}>{company.name}</span>
                      <span className={styles.meta}>
                        {company.code}
                        {user.profile.is_super_admin ? (
                          <span className={styles.roleTag} style={{ background: 'rgba(201,168,76,0.15)', color: 'var(--gold)' }}>
                            super_admin
                          </span>
                        ) : cu ? (
                          <span className={styles.roleTag}>{cu.role}</span>
                        ) : null}
                      </span>
                    </span>
                    <ChevronRight size={18} className={styles.arrow} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <button className={styles.signOutBtn} onClick={signOut}>
          Sign out
        </button>
      </div>
    </div>
  )
}
