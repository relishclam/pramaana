import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react'
import { fetchPendingCount } from '@/lib/approvals'
import { fetchAwaitingPaymentsCount } from '@/lib/pay-now'

// ── Context shape ─────────────────────────────────────────────────────────────

interface ApprovalContextValue {
  pendingCount:   number
  paymentsCount:  number
  refreshCount: (companyId: string) => Promise<void>
}

const ApprovalContext = createContext<ApprovalContextValue>({
  pendingCount:  0,
  paymentsCount: 0,
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
  const [pendingCount,  setPendingCount]  = useState(0)
  const [paymentsCount, setPaymentsCount] = useState(0)

  const refreshCount = useCallback(async (cid: string) => {
    const [approvals, payments] = await Promise.all([
      fetchPendingCount(cid),
      fetchAwaitingPaymentsCount(cid),
    ])
    setPendingCount(approvals)
    setPaymentsCount(payments)
  }, [])

  useEffect(() => {
    if (companyId) refreshCount(companyId)
  }, [companyId, refreshCount])

  return (
    <ApprovalContext.Provider value={{ pendingCount, paymentsCount, refreshCount }}>
      {children}
    </ApprovalContext.Provider>
  )
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useApprovalCount() {
  return useContext(ApprovalContext)
}
