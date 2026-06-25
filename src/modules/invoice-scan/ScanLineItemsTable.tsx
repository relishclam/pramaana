import { useState }                from 'react'
import { toast }                   from 'sonner'
import { updateScanItem, type InvoiceScanItem } from './hooks/useInvoiceScans'
import css                         from './ScanLineItemsTable.module.css'

const CATEGORIES = [
  { value: '',             label: '— Not classified —' },
  { value: 'raw_material', label: 'Raw Material'       },
  { value: 'spare',        label: 'Spare Part'         },
  { value: 'consumable',   label: 'Consumable'         },
  { value: 'maintenance',  label: 'Maintenance'        },
  { value: 'packaging',    label: 'Packaging'          },
  { value: 'other',        label: 'Other'              },
]

interface Props {
  items:     InvoiceScanItem[]
  readOnly?: boolean
  onUpdate?: () => void
}

export default function ScanLineItemsTable({ items, readOnly = false, onUpdate }: Props) {
  const [saving, setSaving] = useState<string | null>(null)

  const handleCategoryChange = async (itemId: string, category: string) => {
    setSaving(itemId)
    const { error } = await updateScanItem(itemId, category || null)
    setSaving(null)
    if (error) {
      toast.error('Failed to save category: ' + error)
    } else {
      onUpdate?.()
    }
  }

  if (items.length === 0) {
    return <div className={css.empty}>No line items extracted.</div>
  }

  return (
    <div className={css.tableWrap}>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Description</th>
            <th>HSN/SAC</th>
            <th>Qty</th>
            <th>Unit</th>
            <th className={css.right}>Rate</th>
            <th className={css.right}>Amount</th>
            <th>Category</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr key={item.id}>
              <td className={css.muted}>{item.line_no}</td>
              <td>{item.description ?? '—'}</td>
              <td className={css.muted}>{item.hsn_sac ?? '—'}</td>
              <td className={css.muted}>{item.quantity ?? '—'}</td>
              <td className={css.muted}>{item.unit ?? '—'}</td>
              <td className={css.right}>
                {item.unit_price !== null
                  ? new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(item.unit_price)
                  : '—'}
              </td>
              <td className={css.right}>
                {item.amount !== null
                  ? new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(item.amount)
                  : '—'}
              </td>
              <td>
                {readOnly ? (
                  <span>{CATEGORIES.find(c => c.value === item.item_category)?.label ?? '—'}</span>
                ) : (
                  <select
                    className={css.catSelect}
                    value={item.item_category ?? ''}
                    disabled={saving === item.id}
                    onChange={e => handleCategoryChange(item.id, e.target.value)}
                  >
                    {CATEGORIES.map(c => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
