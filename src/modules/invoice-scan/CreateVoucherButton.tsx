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
          voucher_type: scan.type === 'purchase' ? 'PURCHASE' : 'SALE',
          party_name:   scan.party_name,
          party_gstin:  scan.party_gstin,
          amount:       scan.total_amount,
          narration:    `Invoice ${scan.invoice_no ?? ''} dated ${scan.invoice_date ?? ''}`.trim(),
          bill_ref:     scan.storage_path,
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
