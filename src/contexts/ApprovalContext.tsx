import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react'
import { fetchPendingCount } from '@/lib/approvals'

// ── Context shape ─────────────────────────────────────────────────────────────

interface ApprovalContextValue {
  pendingCount: number
  refreshCount: (companyId: string) => Promise<void>
}

const ApprovalContext = createContext<ApprovalContextValue>({
  pendingCount: 0,
  refreshCount: async () => {},
})

// ── Provider ──────────────────────────────────────────────────────────────────

export function ApprovalProvider({
  children,
  companyId,
}: {
  children: ReactNode
  companyId: string
}) {
  const [pendingCount, setPendingCount] = useState(0)

  const refreshCount = useCallback(async (cid: string) => {
    const n = await fetchPendingCount(cid)
    setPendingCount(n)
  }, [])

  useEffect(() => {
    if (companyId) refreshCount(companyId)
  }, [companyId, refreshCount])

  return (
    <ApprovalContext.Provider value={{ pendingCount, refreshCount }}>
      {children}
    </ApprovalContext.Provider>
  )
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useApprovalCount() {
  return useContext(ApprovalContext)
}
