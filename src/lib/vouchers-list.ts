import { supabase } from '@/lib/supabase'
import { getNextSequence } from '@/lib/vouchers'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RegisterFilters {
  status:   string   // '' | 'draft' | 'pending_approval' | 'posted' | 'cancelled'
  nature:   string   // '' | 'payment' | 'receipt' | 'journal' | 'contra' | 'purchase' | 'sales'
  dateFrom: string   // ISO date YYYY-MM-DD
  dateTo:   string   // ISO date YYYY-MM-DD
  search:   string   // voucher_number or party name
}

export interface RegisterVoucher {
  id:              string
  voucher_number:  string
  voucher_date:    string
  amount:          number
  status:          string
  narration:       string | null
  created_at:      string
  posted_at:       string | null
  entity_id:       string | null
  created_by:      string
  created_by_name: string
  entity_name:     string | null
  voucher_type:    { code: string; name: string; nature: string; prefix: string }
}

const PAGE_SIZE = 50

// ── Fetch paginated, filtered voucher list ────────────────────────────────────

export async function fetchVouchers(
  companyId: string,
  userId:    string,
  role:      string | null,
  filters:   RegisterFilters,
  page:      number,
): Promise<{ rows: RegisterVoucher[]; hasMore: boolean }> {

  type RawRow = {
    id: string; voucher_number: string; voucher_date: string
    amount: number; status: string; narration: string | null
    created_at: string; posted_at: string | null
    entity_id: string | null; created_by: string
    voucher_type: { code: string; name: string; nature: string; prefix: string } | null
  }

  // Resolve voucher_type_ids for nature filter (PostgREST can't filter embedded columns)
  let typeIds: string[] | null = null
  if (filters.nature) {
    const { data: vt } = await supabase
      .schema('pramaana')
      .from('voucher_types')
      .select('id')
      .eq('nature', filters.nature)
    typeIds = ((vt ?? []) as { id: string }[]).map(v => v.id)
    if (typeIds.length === 0) return { rows: [], hasMore: false }
  }

  // Resolve entity_ids for party name search (cross-schema)
  let searchEntityIds: string[] | null = null
  if (filters.search) {
    const { data: ents } = await supabase
      .schema('registry')
      .from('entities')
      .select('id')
      .ilike('display_name', `%${filters.search}%`)
      .limit(50)
    searchEntityIds = ((ents ?? []) as { id: string }[]).map(e => e.id)
  }

  // Build the main query — fetch PAGE_SIZE+1 to detect hasMore
  let q = supabase
    .schema('pramaana')
    .from('vouchers')
    .select(
      'id, voucher_number, voucher_date, amount, status, narration, created_at, posted_at, entity_id, created_by, voucher_type:voucher_types(code, name, nature, prefix)'
    )
    .eq('company_id', companyId)
    .gte('voucher_date', filters.dateFrom)
    .lte('voucher_date', filters.dateTo)
    .order('voucher_date', { ascending: false })
    .order('created_at',   { ascending: false })
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) // +1 to detect hasMore

  // Imported vouchers are system-seeded — no special status grouping needed.
  // Each tab maps 1:1 to a real DB status value.
  if (filters.status) {
    q = q.eq('status', filters.status)
  }
  if (typeIds)               q = q.in('voucher_type_id', typeIds)

  if (filters.search) {
    if (searchEntityIds && searchEntityIds.length > 0) {
      q = q.or(
        `voucher_number.ilike.%${filters.search}%,entity_id.in.(${searchEntityIds.join(',')})`
      )
    } else {
      q = q.ilike('voucher_number', `%${filters.search}%`)
    }
  }

  const { data, error } = await q
  if (error) throw new Error('Failed to load vouchers: ' + error.message)

  const rawRows = (data ?? []) as unknown as RawRow[]
  const hasMore = rawRows.length > PAGE_SIZE
  const rows    = hasMore ? rawRows.slice(0, PAGE_SIZE) : rawRows

  // Batch-fetch profiles + entity names (cross-schema)
  const creatorIds = [...new Set(rows.map(r => r.created_by).filter(Boolean) as string[])]
  const entityIds  = [...new Set(rows.map(r => r.entity_id).filter(Boolean) as string[])]

  const [profilesRes, entitiesRes] = await Promise.all([
    creatorIds.length > 0
      ? supabase.schema('registry').from('profiles').select('id, full_name').in('id', creatorIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
    entityIds.length > 0
      ? supabase.schema('registry').from('entities').select('id, display_name').in('id', entityIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
  ])

  const profileMap = new Map<string, string>(
    ((profilesRes.data ?? []) as { id: string; full_name: string | null }[])
      .map(p => [p.id, p.full_name ?? 'Unknown'])
  )
  const entityMap = new Map<string, string>(
    ((entitiesRes.data ?? []) as { id: string; display_name: string }[])
      .map(e => [e.id, e.display_name])
  )

  return {
    rows: rows.map(r => ({
      id:              r.id,
      voucher_number:  r.voucher_number,
      voucher_date:    r.voucher_date,
      amount:          r.amount,
      status:          r.status,
      narration:       r.narration,
      created_at:      r.created_at,
      posted_at:       r.posted_at,
      entity_id:       r.entity_id,
      created_by:      r.created_by,
      created_by_name: profileMap.get(r.created_by) ?? 'Unknown',
      entity_name:     r.entity_id ? (entityMap.get(r.entity_id) ?? null) : null,
      voucher_type:    r.voucher_type ?? { code: '?', name: 'Unknown', nature: '', prefix: '' },
    })),
    hasMore,
  }
}

// ── Recall voucher (pending → draft) ─────────────────────────────────────────

export async function recallVoucher(voucherId: string): Promise<void> {
  const { error } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update({ status: 'draft' })
    .eq('id', voucherId)
    .eq('status', 'pending_approval')
  if (error) throw new Error('Failed to recall voucher: ' + error.message)
}

// ── Delete draft voucher ──────────────────────────────────────────────────────

export async function deleteVoucher(voucherId: string): Promise<void> {
  const { error } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .delete()
    .eq('id', voucherId)
    .eq('status', 'draft')
  if (error) throw new Error('Failed to delete voucher: ' + error.message)
}

// ── Submit draft → pending_approval (generates real voucher number) ────────────

export async function submitDraftVoucher(
  voucherId:   string,
  companyId:   string,
  companyCode: string,
  prefix:      string,
): Promise<void> {
  const voucherNumber = await getNextSequence(companyId, companyCode, prefix)
  const { error } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .update({ voucher_number: voucherNumber, status: 'pending_approval' })
    .eq('id', voucherId)
    .eq('status', 'draft')
  if (error) throw new Error('Failed to submit voucher: ' + error.message)
}

// ── Advanced Voucher Search ───────────────────────────────────────────────────

export interface AdvancedFilters {
  payee:       string   // entity display_name search
  ledgerId:    string   // head of account (ledger) id
  dateFrom:    string
  dateTo:      string
  amountType:  'exact' | 'gte' | 'lte' | ''
  amountValue: string
  nature:      string   // voucher type nature filter
}

export interface AdvancedVoucherResult {
  id:             string
  voucher_number: string
  voucher_date:   string
  amount:         number
  status:         string
  narration:      string | null
  party_name:     string | null
  voucher_type:   string
  nature:         string
}

export async function fetchAdvancedVoucherSearch(
  companyId: string,
  filters:   AdvancedFilters,
): Promise<AdvancedVoucherResult[]> {
  // 1. Resolve payee → entity_ids
  let entityIds: string[] | null = null
  if (filters.payee.trim()) {
    const { data: ents } = await supabase
      .schema('registry').from('entities')
      .select('id').ilike('display_name', `%${filters.payee.trim()}%`).limit(100)
    entityIds = ((ents ?? []) as { id: string }[]).map(e => e.id)
    if (entityIds.length === 0) return []
  }

  // 2. Resolve head of account ledger → voucher_ids that touch it
  let ledgerVoucherIds: string[] | null = null
  if (filters.ledgerId) {
    const { data: ev, error: evErr } = await supabase
      .schema('pramaana').from('voucher_entries')
      .select('voucher_id').eq('ledger_id', filters.ledgerId)
    if (evErr) throw new Error(evErr.message)
    ledgerVoucherIds = [...new Set(((ev ?? []) as { voucher_id: string }[]).map(r => r.voucher_id))]
    if (ledgerVoucherIds.length === 0) return []
  }

  // 3. Resolve nature → type_ids
  let typeIds: string[] | null = null
  if (filters.nature) {
    const { data: vt } = await supabase
      .schema('pramaana').from('voucher_types').select('id').eq('nature', filters.nature)
    typeIds = ((vt ?? []) as { id: string }[]).map(t => t.id)
    if (typeIds.length === 0) return []
  }

  // 4. Build main query
  let q = supabase
    .schema('pramaana').from('vouchers')
    .select('id, voucher_number, voucher_date, amount, status, narration, entity_id, voucher_types(name, nature)')
    .eq('company_id', companyId)
    .gte('voucher_date', filters.dateFrom)
    .lte('voucher_date', filters.dateTo)
    .order('voucher_date', { ascending: false })
    .order('created_at',   { ascending: false })
    .limit(500)

  if (entityIds        !== null) q = q.in('entity_id',       entityIds)
  if (ledgerVoucherIds !== null) q = q.in('id',              ledgerVoucherIds)
  if (typeIds          !== null) q = q.in('voucher_type_id', typeIds)

  const amtVal = parseFloat(filters.amountValue)
  if (filters.amountType && !isNaN(amtVal)) {
    if      (filters.amountType === 'exact') q = q.eq ('amount', amtVal)
    else if (filters.amountType === 'gte')   q = q.gte('amount', amtVal)
    else if (filters.amountType === 'lte')   q = q.lte('amount', amtVal)
  }

  const { data, error } = await q
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as unknown as {
    id: string; voucher_number: string; voucher_date: string
    amount: number; status: string; narration: string | null
    entity_id: string | null
    voucher_types: { name: string; nature: string } | null
  }[]

  // 5. Batch-fetch entity display names
  const allEids = [...new Set(rows.map(r => r.entity_id).filter(Boolean) as string[])]
  const nameMap = new Map<string, string>()
  if (allEids.length > 0) {
    const { data: ents } = await supabase
      .schema('registry').from('entities').select('id, display_name').in('id', allEids)
    ;(ents ?? []).forEach((e: { id: string; display_name: string }) => nameMap.set(e.id, e.display_name))
  }

  return rows.map(r => ({
    id:             r.id,
    voucher_number: r.voucher_number,
    voucher_date:   r.voucher_date,
    amount:         r.amount,
    status:         r.status,
    narration:      r.narration,
    party_name:     r.entity_id ? (nameMap.get(r.entity_id) ?? null) : null,
    voucher_type:   r.voucher_types?.name ?? '—',
    nature:         r.voucher_types?.nature ?? '',
  }))
}
