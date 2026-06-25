/**
 * useInvoiceScans — Supabase query hook for the invoice_scans inbox.
 *
 * Provides: list (with filters), single detail fetch, and status update.
 */

import { useState, useEffect, useCallback } from 'react'
import { supabase }                         from '@/lib/supabase'

// ── Types ──────────────────────────────────────────────────────────────────────

export type ScanStatus = 'pending' | 'reviewed' | 'voucher_created' | 'rejected'
export type ScanType   = 'purchase' | 'sale'

export interface InvoiceScan {
  id:            string
  company_id:    string
  scan_ref:      string
  type:          ScanType
  invoice_no:    string | null
  invoice_date:  string | null
  party_name:    string | null
  party_gstin:   string | null
  our_gstin:     string | null
  taxable_value: number
  total_gst:     number
  cgst:          number
  sgst:          number
  igst:          number
  total_amount:  number
  gst_type:      'intra' | 'inter' | 'unknown' | null
  raw_json:      Record<string, unknown> | null
  confidence:    number | null
  storage_path:  string | null
  status:        ScanStatus
  voucher_id:    string | null
  scanned_by:    string | null
  scanned_at:    string
  reviewed_by:   string | null
  reviewed_at:   string | null
}

export interface InvoiceScanItem {
  id:             string
  scan_id:        string
  company_id:     string
  line_no:        number
  description:    string | null
  hsn_sac:        string | null
  quantity:       number | null
  unit:           string | null
  unit_price:     number | null
  amount:         number | null
  item_category:  string | null
  item_code:      string | null
  matched_status: string
  created_at:     string
}

// ── Filters for inbox list ─────────────────────────────────────────────────────

export interface ScanFilters {
  companyId:  string
  type?:      ScanType
  status?:    ScanStatus
  dateFrom?:  string   // YYYY-MM-DD
  dateTo?:    string   // YYYY-MM-DD
}

// ── List hook ──────────────────────────────────────────────────────────────────

export function useInvoiceScans(filters: ScanFilters) {
  const [scans,   setScans]   = useState<InvoiceScan[]>([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!filters.companyId) return
    setLoading(true)
    setError(null)

    let query = supabase
      .schema('pramaana')
      .from('invoice_scans')
      .select('*')
      .eq('company_id', filters.companyId)
      .order('scanned_at', { ascending: false })

    if (filters.type)     query = query.eq('type',   filters.type)
    if (filters.status)   query = query.eq('status', filters.status)
    if (filters.dateFrom) query = query.gte('invoice_date', filters.dateFrom)
    if (filters.dateTo)   query = query.lte('invoice_date', filters.dateTo)

    const { data, error: err } = await query.limit(200)

    if (err) {
      setError(err.message)
    } else {
      setScans((data ?? []) as InvoiceScan[])
    }
    setLoading(false)
  }, [filters.companyId, filters.type, filters.status, filters.dateFrom, filters.dateTo])

  useEffect(() => { load() }, [load])

  return { scans, loading, error, refresh: load }
}

// ── Detail hook (single scan + its items) ─────────────────────────────────────

export function useInvoiceScanDetail(scanId: string) {
  const [scan,    setScan]    = useState<InvoiceScan | null>(null)
  const [items,   setItems]   = useState<InvoiceScanItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!scanId) return
    setLoading(true)
    setError(null)

    const [scanRes, itemsRes] = await Promise.all([
      supabase
        .schema('pramaana')
        .from('invoice_scans')
        .select('*')
        .eq('id', scanId)
        .single(),
      supabase
        .schema('pramaana')
        .from('invoice_scan_items')
        .select('*')
        .eq('scan_id', scanId)
        .order('line_no'),
    ])

    if (scanRes.error) {
      setError(scanRes.error.message)
    } else {
      setScan(scanRes.data as InvoiceScan)
      setItems((itemsRes.data ?? []) as InvoiceScanItem[])
    }
    setLoading(false)
  }, [scanId])

  useEffect(() => { load() }, [load])

  return { scan, items, loading, error, refresh: load }
}

// ── Status update ──────────────────────────────────────────────────────────────

export async function updateScanStatus(
  scanId:     string,
  status:     ScanStatus,
  reviewedBy: string,
  voucherId?: string,
): Promise<{ error: string | null }> {
  const patch: Partial<InvoiceScan> & { reviewed_by?: string; reviewed_at?: string } = {
    status,
    reviewed_by: reviewedBy,
    reviewed_at: new Date().toISOString(),
  }
  if (voucherId) (patch as { voucher_id?: string }).voucher_id = voucherId

  const { error } = await supabase
    .schema('pramaana')
    .from('invoice_scans')
    .update(patch)
    .eq('id', scanId)

  return { error: error?.message ?? null }
}

// ── Item category update ───────────────────────────────────────────────────────

export async function updateScanItem(
  itemId:       string,
  itemCategory: string | null,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .schema('pramaana')
    .from('invoice_scan_items')
    .update({ item_category: itemCategory })
    .eq('id', itemId)

  return { error: error?.message ?? null }
}
