import { useState }    from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText }    from 'lucide-react'
import { toast }       from 'sonner'
import { useAuth }     from '@/contexts/AuthContext'
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

    // Mark as voucher_created immediately so the scan_ref is "locked"
    // The actual voucher is created by the existing VoucherEntry flow.
    // We pass the scan data via navigation state so VoucherEntry can prefill.
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
