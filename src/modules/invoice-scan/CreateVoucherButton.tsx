import { useState }    from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText }    from 'lucide-react'
import { toast }       from 'sonner'
import { useAuth }     from '@/contexts/AuthContext'
import { supabase }    from '@/lib/supabase'
import { updateScanStatus, type InvoiceScan } from './hooks/useInvoiceScans'
import css from './ScanDetail.module.css'   // reuse ScanDetail button styles

interface Props {
  scan:      InvoiceScan
  onCreated: () => void
}

export default function CreateVoucherButton({ scan, onCreated }: Props) {
  const { user }  = useAuth()
  const navigate  = useNavigate()
  const userId    = user?.id ?? ''
  const [saving, setSaving] = useState(false)

  const handleClick = async () => {
    setSaving(true)

    // ── Resolve entity_id from party_gstin (fallback: name search) ──────────
    // Without entity_id the voucher is saved with entity_id=null, so the
    // Approval Queue PARTY column shows "—".  Look it up here so VoucherEntry
    // receives a resolved entity_id and sets it automatically.
    let resolvedEntityId:   string | null = null
    let resolvedEntityName: string | null = scan.party_name ?? null

    if (scan.party_gstin) {
      const { data: byGstin } = await supabase
        .schema('registry')
        .from('entities')
        .select('id, display_name')
        .ilike('gstin', scan.party_gstin)
        .maybeSingle()
      if (byGstin) {
        resolvedEntityId   = byGstin.id
        resolvedEntityName = byGstin.display_name
      }
    }

    if (!resolvedEntityId && scan.party_name) {
      const cleanedName = scan.party_name
        .replace(/\bpvt\.?\s*ltd\.?\b/gi, '')
        .replace(/\bprivate\s+limited\b/gi, '')
        .replace(/\blimited\b/gi, '')
        .replace(/\binc\.?\b/gi, '')
        .trim()

      // Step 2: full cleaned name
      if (cleanedName.length > 2) {
        const { data: byName } = await supabase
          .schema('registry')
          .from('entities')
          .select('id, display_name')
          .ilike('display_name', `%${cleanedName}%`)
          .limit(1)
          .maybeSingle()
        if (byName) {
          resolvedEntityId   = byName.id
          resolvedEntityName = byName.display_name
        }
      }

      // Step 3: first significant word fallback
      if (!resolvedEntityId) {
        const firstWord = cleanedName.split(/\s+/)[0] ?? ''
        if (firstWord.length >= 5) {
          const { data: byWord } = await supabase
            .schema('registry')
            .from('entities')
            .select('id, display_name')
            .ilike('display_name', `%${firstWord}%`)
            .limit(1)
            .maybeSingle()
          if (byWord) {
            resolvedEntityId   = byWord.id
            resolvedEntityName = byWord.display_name
          }
        }
      }
    }

    // Mark scan as voucher_created
    const { error } = await updateScanStatus(scan.id, 'voucher_created', userId)
    setSaving(false)

    if (error) {
      toast.error('Could not update scan status: ' + error)
      return
    }

    onCreated()

    navigate('/vouchers/new', {
      state: {
        fromScan: true,
        scanId:   scan.id,
        prefill: {
          voucher_type:  scan.type === 'purchase' ? 'PURCHASE' : 'SALE',
          entity_id:     resolvedEntityId,
          entity_name:   resolvedEntityName,
          party_name:    scan.party_name,
          party_gstin:   scan.party_gstin,
          // Taxable value drives GST Quick-Add; use it as 'amount', not total_amount
          amount:        scan.taxable_value,
          taxable_value: scan.taxable_value,
          total_gst:     scan.total_gst,
          cgst:          scan.cgst,
          sgst:          scan.sgst,
          igst:          scan.igst,
          gst_type:      scan.gst_type,
          invoice_date:  scan.invoice_date,
          narration:     [
            scan.party_name,
            scan.invoice_no  ? `Inv ${scan.invoice_no}`   : '',
            scan.invoice_date ? `dt ${scan.invoice_date}` : '',
          ].filter(Boolean).join(' \u00b7 '),
          // bill_ref = invoice number shown in Reference No. field (not storage path)
          bill_ref: scan.invoice_no ?? null,
        },
      },
    })
  }

  return (
    <button
      className={css.btnPrimary}
      onClick={handleClick}
      disabled={saving}
    >
      <FileText size={15} />
      {saving ? 'Creating…' : 'Create Voucher'}
    </button>
  )
}
