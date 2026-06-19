import { supabase } from './supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DashboardStats {
  todayCount:        number
  monthCount:        number
  openSuspenseCount: number
}

export interface RecentVoucher {
  id:             string
  voucher_number: string | null
  voucher_date:   string
  narration:      string | null
  amount:         number
  status:         string
  voucher_types:  { name: string; nature: string } | null
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function fetchDashboardStats(companyId: string): Promise<DashboardStats> {
  const today      = new Date().toISOString().slice(0, 10)
  const monthStart = today.slice(0, 7) + '-01'

  const [todayRes, monthRes, suspenseRes] = await Promise.all([
    supabase.schema('pramaana')
      .from('vouchers')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('voucher_date', today),

    supabase.schema('pramaana')
      .from('vouchers')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gte('voucher_date', monthStart)
      .lte('voucher_date', today),

    supabase.schema('pramaana')
      .from('settlement_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('status', ['open', 'pending_approval']),
  ])

  return {
    todayCount:        todayRes.count        ?? 0,
    monthCount:        monthRes.count        ?? 0,
    openSuspenseCount: suspenseRes.count     ?? 0,
  }
}

export async function fetchRecentVouchers(companyId: string, limit = 8): Promise<RecentVoucher[]> {
  const { data, error } = await supabase.schema('pramaana')
    .from('vouchers')
    .select('id, voucher_number, voucher_date, narration, amount, status, voucher_types(name, nature)')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error
  return (data ?? []) as unknown as RecentVoucher[]
}
