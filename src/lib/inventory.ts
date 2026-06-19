import { supabaseClamFlow } from './supabaseClamFlow'
import { supabase } from './supabase'

// ── ClamFlow types (READ ONLY) ────────────────────────────────────────────────

export interface ClamLot {
  id: string
  lot_number: string | null
  species: string | null
  weight_kg: number | null
  arrival_date: string | null
  status: string | null
  supplier_id: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface ClamFPForm {
  id: string
  lot_id: string | null
  status: string | null
  created_at: string
  updated_at: string
}

// ── Pramaana valuation type ───────────────────────────────────────────────────

export interface InventoryValuation {
  id: string
  company_id: string
  lot_id: string
  rate_per_kg: number
  notes: string | null
  valued_by: string | null
  valued_at: string
  updated_at: string
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

/** Fetch all lots from ClamFlow (READ ONLY). */
export async function fetchClamLots(): Promise<ClamLot[]> {
  const { data, error } = await supabaseClamFlow
    .from('lots')
    .select('id, lot_number, species, weight_kg, arrival_date, status, supplier_id, notes, created_at, updated_at')
    .order('arrival_date', { ascending: false })
    .limit(500)

  if (error) throw error
  return (data ?? []) as ClamLot[]
}

/** Fetch all fish-processing forms from ClamFlow (READ ONLY). */
export async function fetchClamFPForms(): Promise<ClamFPForm[]> {
  const { data, error } = await supabaseClamFlow
    .from('fp_forms')
    .select('id, lot_id, status, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) throw error
  return (data ?? []) as ClamFPForm[]
}

/** Fetch all inventory valuations for a company from Pramaana. */
export async function fetchInventoryValuations(companyId: string): Promise<InventoryValuation[]> {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('inventory_valuations')
    .select('*')
    .eq('company_id', companyId)

  if (error) throw error
  return (data ?? []) as InventoryValuation[]
}

/** Upsert a valuation (Admin/Super-Admin only — enforced by RLS). */
export async function upsertInventoryValuation(
  companyId: string,
  lotId: string,
  ratePerKg: number,
  notes: string | null,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .schema('pramaana')
    .from('inventory_valuations')
    .upsert(
      {
        company_id: companyId,
        lot_id:     lotId,
        rate_per_kg: ratePerKg,
        notes,
        valued_by:  userId,
        valued_at:  new Date().toISOString(),
      },
      { onConflict: 'company_id,lot_id' },
    )

  if (error) throw error
}
