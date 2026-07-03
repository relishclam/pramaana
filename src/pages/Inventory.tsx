import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import {
  fetchClamLots,
  fetchClamFPForms,
  fetchInventoryValuations,
  upsertInventoryValuation,
  type ClamLot,
  type ClamFPForm,
  type InventoryValuation,
} from '@/lib/inventory'
import FoodStreamMini from '@/components/FoodStreamMini'
import css from './Inventory.module.css'

// ── helpers
import css from './Inventory.module.css' ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined) {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function statusBadge(status: string | null, css_module: Record<string, string>) {
  if (!status) return <span className={css_module.badge}>—</span>
  const s = status.toLowerCase()
  let cls = css_module.badge
  if (s.includes('stock') || s.includes('receiv') || s.includes('available') || s === 'in_stock')
    cls = css_module.badgeGreen
  else if (s.includes('process') || s.includes('wip') || s.includes('progress'))
    cls = css_module.badgeAmber
  else if (s.includes('complet') || s.includes('done') || s.includes('dispatch'))
    cls = css_module.badgeBlue
  return <span className={cls}>{status.replace(/_/g, ' ')}</span>
}

// ── Rate edit form (inline) ───────────────────────────────────────────────────

interface RateEditProps {
  colSpan: number
  lotId: string
  companyId: string
  userId: string
  current: InventoryValuation | undefined
  onSaved: (val: InventoryValuation) => void
  onCancel: () => void
}

function RateEditRow({ colSpan, lotId, companyId, userId, current, onSaved, onCancel }: RateEditProps) {
  const [rate, setRate] = useState(current ? String(current.rate_per_kg) : '')
  const [notes, setNotes] = useState(current?.notes ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    const parsed = parseFloat(rate)
    if (!rate || isNaN(parsed) || parsed < 0) {
      toast.error('Enter a valid rate per kg (≥ 0)')
      return
    }
    setSaving(true)
    try {
      await upsertInventoryValuation(companyId, lotId, parsed, notes.trim() || null, userId)
      onSaved({
        id: current?.id ?? '',
        company_id: companyId,
        lot_id: lotId,
        rate_per_kg: parsed,
        notes: notes.trim() || null,
        valued_by: userId,
        valued_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      toast.success('Rate saved')
    } catch (e: unknown) {
      toast.error((e as Error).message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className={css.editRow}>
      <td colSpan={colSpan}>
        <div className={css.editForm}>
          <span className={css.editLabel}>Rate / kg (₹)</span>
          <input
            className={css.editInput}
            type="number"
            min="0"
            step="0.01"
            placeholder="e.g. 120.00"
            value={rate}
            onChange={e => setRate(e.target.value)}
            autoFocus
          />
          <span className={css.editLabel}>Notes</span>
          <input
            className={css.editNotesInput}
            type="text"
            placeholder="Optional"
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
          <button className={css.saveBtn} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className={css.cancelBtn} onClick={onCancel}>Cancel</button>
        </div>
      </td>
    </tr>
  )
}

// ── In-Stock tab ──────────────────────────────────────────────────────────────

interface InStockProps {
  lots: ClamLot[]
  valuations: Map<string, InventoryValuation>
  canEdit: boolean
  companyId: string
  userId: string
  onValuationSaved: (v: InventoryValuation) => void
}

function InStockTable({ lots, valuations, canEdit, companyId, userId, onValuationSaved }: InStockProps) {
  const [editingId, setEditingId] = useState<string | null>(null)

  if (lots.length === 0) {
    return <div className={css.empty}>No in-stock lots found in ClamFlow.<br />Data will appear here once ClamFlow goes live.</div>
  }

  const totalKg = lots.reduce((s, l) => s + (l.weight_kg ?? 0), 0)
  const totalValue = lots.reduce((s, l) => {
    const v = valuations.get(l.id)
    if (!v || !l.weight_kg) return s
    return s + v.rate_per_kg * l.weight_kg
  }, 0)

  return (
    <div className={css.tableWrap}>
      <table className={css.table}>
        <thead>
          <tr>
            <th>Lot #</th>
            <th>Species</th>
            <th>Arrival Date</th>
            <th>Status</th>
            <th className={css.right}>Weight (kg)</th>
            <th className={css.right}>Rate / kg (₹)</th>
            <th className={css.right}>Total Value (₹)</th>
          </tr>
        </thead>
        <tbody>
          {lots.map(lot => {
            const val = valuations.get(lot.id)
            const totalVal = val && lot.weight_kg ? val.rate_per_kg * lot.weight_kg : null

            return (
              <>
                <tr key={lot.id}>
                  <td>{lot.lot_number ?? <span className={css.muted}>—</span>}</td>
                  <td>{lot.species ?? <span className={css.muted}>—</span>}</td>
                  <td className={css.muted}>{fmtDate(lot.arrival_date)}</td>
                  <td>{statusBadge(lot.status, css)}</td>
                  <td className={css.right}>{fmt(lot.weight_kg)}</td>
                  <td>
                    <div className={css.rateCell}>
                      {val
                        ? <span className={css.rateDisplay}>₹ {fmt(val.rate_per_kg)}</span>
                        : <span className={css.rateEmpty}>not set</span>
                      }
                      {canEdit && (
                        <button
                          className={css.setRateBtn}
                          onClick={() => setEditingId(editingId === lot.id ? null : lot.id)}
                        >
                          {val ? 'Edit' : 'Set Rate'}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className={css.right}>
                    {totalVal != null ? `₹ ${fmt(totalVal)}` : <span className={css.muted}>—</span>}
                  </td>
                </tr>
                {editingId === lot.id && (
                  <RateEditRow
                    key={`edit-${lot.id}`}
                    colSpan={7}
                    lotId={lot.id}
                    companyId={companyId}
                    userId={userId}
                    current={val}
                    onSaved={v => { onValuationSaved(v); setEditingId(null) }}
                    onCancel={() => setEditingId(null)}
                  />
                )}
              </>
            )
          })}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
            <td colSpan={4} style={{ paddingLeft: '0.75rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Total</td>
            <td className={css.right}>{fmt(totalKg)}</td>
            <td />
            <td className={css.right} style={{ color: 'var(--gold)' }}>
              {totalValue > 0 ? `₹ ${fmt(totalValue)}` : '—'}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── WIP tab ───────────────────────────────────────────────────────────────────

interface WIPProps {
  forms: ClamFPForm[]
  lotsMap: Map<string, ClamLot>
  valuations: Map<string, InventoryValuation>
  canEdit: boolean
  companyId: string
  userId: string
  onValuationSaved: (v: InventoryValuation) => void
}

function WIPTable({ forms, lotsMap, valuations, canEdit, companyId, userId, onValuationSaved }: WIPProps) {
  const [editingId, setEditingId] = useState<string | null>(null)

  if (forms.length === 0) {
    return <div className={css.empty}>No work-in-progress forms found in ClamFlow.<br />Data will appear here once ClamFlow goes live.</div>
  }

  const totalValue = forms.reduce((s, f) => {
    if (!f.lot_id) return s
    const lot = lotsMap.get(f.lot_id)
    const val = valuations.get(f.lot_id)
    if (!lot || !val || !lot.weight_kg) return s
    return s + val.rate_per_kg * lot.weight_kg
  }, 0)

  return (
    <div className={css.tableWrap}>
      <table className={css.table}>
        <thead>
          <tr>
            <th>Form ID</th>
            <th>Lot #</th>
            <th>Species</th>
            <th>Status</th>
            <th className={css.right}>Weight (kg)</th>
            <th className={css.right}>Rate / kg (₹)</th>
            <th className={css.right}>WIP Value (₹)</th>
          </tr>
        </thead>
        <tbody>
          {forms.map(form => {
            const lot = form.lot_id ? lotsMap.get(form.lot_id) : undefined
            const val = form.lot_id ? valuations.get(form.lot_id) : undefined
            const wipVal = val && lot?.weight_kg ? val.rate_per_kg * lot.weight_kg : null
            const lotId = form.lot_id ?? ''

            return (
              <>
                <tr key={form.id}>
                  <td className={css.muted} style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                    {form.id.slice(0, 8)}…
                  </td>
                  <td>{lot?.lot_number ?? <span className={css.muted}>—</span>}</td>
                  <td>{lot?.species ?? <span className={css.muted}>—</span>}</td>
                  <td>{statusBadge(form.status, css)}</td>
                  <td className={css.right}>{fmt(lot?.weight_kg)}</td>
                  <td>
                    <div className={css.rateCell}>
                      {val
                        ? <span className={css.rateDisplay}>₹ {fmt(val.rate_per_kg)}</span>
                        : <span className={css.rateEmpty}>not set</span>
                      }
                      {canEdit && lotId && (
                        <button
                          className={css.setRateBtn}
                          onClick={() => setEditingId(editingId === form.id ? null : form.id)}
                        >
                          {val ? 'Edit' : 'Set Rate'}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className={css.right}>
                    {wipVal != null ? `₹ ${fmt(wipVal)}` : <span className={css.muted}>—</span>}
                  </td>
                </tr>
                {editingId === form.id && lotId && (
                  <RateEditRow
                    key={`edit-${form.id}`}
                    colSpan={7}
                    lotId={lotId}
                    companyId={companyId}
                    userId={userId}
                    current={val}
                    onSaved={v => { onValuationSaved(v); setEditingId(null) }}
                    onCancel={() => setEditingId(null)}
                  />
                )}
              </>
            )
          })}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
            <td colSpan={6} style={{ paddingLeft: '0.75rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Total WIP</td>
            <td className={css.right} style={{ color: 'var(--gold)' }}>
              {totalValue > 0 ? `₹ ${fmt(totalValue)}` : '—'}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Tab = 'stock' | 'wip'

export default function Inventory() {
  const { user } = useAuth()
  const company = user?.activeCompany
  const companyId = company?.id ?? ''
  const userId = user?.id ?? ''

  const isAdmin = user?.profile.is_super_admin || user?.activeRole === 'admin'

  const [tab, setTab] = useState<Tab>('stock')
  const [lots, setLots] = useState<ClamLot[]>([])
  const [forms, setForms] = useState<ClamFPForm[]>([])
  const [valuations, setValuations] = useState<Map<string, InventoryValuation>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    setError(null)
    try {
      const [rawLots, rawForms, rawVals] = await Promise.all([
        fetchClamLots(),
        fetchClamFPForms(),
        fetchInventoryValuations(companyId),
      ])
      setLots(rawLots)
      setForms(rawForms)
      const vmap = new Map<string, InventoryValuation>()
      rawVals.forEach(v => vmap.set(v.lot_id, v))
      setValuations(vmap)
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Failed to load inventory data')
    } finally {
      setLoading(false)
    }
  }, [companyId])

  useEffect(() => { load() }, [load])

  function handleValuationSaved(v: InventoryValuation) {
    setValuations(prev => {
      const next = new Map(prev)
      next.set(v.lot_id, v)
      return next
    })
  }

  const lotsMap = new Map(lots.map(l => [l.id, l]))

  // Totals for summary strip
  const totalStockKg  = lots.reduce((s, l) => s + (l.weight_kg ?? 0), 0)
  const totalStockVal = lots.reduce((s, l) => {
    const v = valuations.get(l.id)
    return v && l.weight_kg ? s + v.rate_per_kg * l.weight_kg : s
  }, 0)
  const totalWIPVal = forms.reduce((s, f) => {
    if (!f.lot_id) return s
    const lot = lotsMap.get(f.lot_id)
    const v = valuations.get(f.lot_id)
    return v && lot?.weight_kg ? s + v.rate_per_kg * lot.weight_kg : s
  }, 0)

  return (
    <div className={css.page}>
      <div className={css.header}>
        <div>
          <h1 className={css.title}>Inventory</h1>
          <p className={css.subtitle}>
            Live data from ClamFlow &nbsp;·&nbsp;
            <span className={css.clamBadge}>ClamFlow · Read Only</span>
            &nbsp;·&nbsp; Valuations set in Pramaana by Admin only
          </p>
        </div>
      </div>

      {error && <div className={css.error}>{error}</div>}

      {loading ? (
        <FoodStreamMini label="" />
      ) : (
        <>
          {/* Summary strip */}
          <div className={css.summaryStrip}>
            <div className={css.summaryCard}>
              <div className={css.summaryLabel}>Lots In-Stock</div>
              <div className={css.summaryValue}>{lots.length}</div>
            </div>
            <div className={css.summaryCard}>
              <div className={css.summaryLabel}>Total Weight (kg)</div>
              <div className={css.summaryValue}>{fmt(totalStockKg)}</div>
            </div>
            <div className={css.summaryCard}>
              <div className={css.summaryLabel}>Raw Material Value</div>
              <div className={css.summaryValueGold}>
                {totalStockVal > 0 ? `₹ ${fmt(totalStockVal)}` : '—'}
              </div>
            </div>
            <div className={css.summaryCard}>
              <div className={css.summaryLabel}>WIP Value</div>
              <div className={css.summaryValueGold}>
                {totalWIPVal > 0 ? `₹ ${fmt(totalWIPVal)}` : '—'}
              </div>
            </div>
            <div className={css.summaryCard}>
              <div className={css.summaryLabel}>Total Closing Stock</div>
              <div className={css.summaryValueGold}>
                {(totalStockVal + totalWIPVal) > 0
                  ? `₹ ${fmt(totalStockVal + totalWIPVal)}`
                  : '—'}
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className={css.tabs}>
            <button
              className={tab === 'stock' ? css.tabActive : css.tab}
              onClick={() => setTab('stock')}
            >
              In-Stock ({lots.length})
            </button>
            <button
              className={tab === 'wip' ? css.tabActive : css.tab}
              onClick={() => setTab('wip')}
            >
              Work in Progress ({forms.length})
            </button>
          </div>

          {tab === 'stock' && (
            <InStockTable
              lots={lots}
              valuations={valuations}
              canEdit={isAdmin}
              companyId={companyId}
              userId={userId}
              onValuationSaved={handleValuationSaved}
            />
          )}

          {tab === 'wip' && (
            <WIPTable
              forms={forms}
              lotsMap={lotsMap}
              valuations={valuations}
              canEdit={isAdmin}
              companyId={companyId}
              userId={userId}
              onValuationSaved={handleValuationSaved}
            />
          )}
        </>
      )}
    </div>
  )
}
