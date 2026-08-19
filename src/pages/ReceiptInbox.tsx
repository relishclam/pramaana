import { useState, useEffect, useCallback, useRef } from 'react'
import { Loader2, Receipt, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import css from './ReceiptInbox.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface VoucherSummary {
  id:             string
  voucher_number: string
  amount:         number
  company_id:     string
}

interface InboxItem {
  id:                  string
  status:              string
  mime_type:           string
  company_id:          string | null
  ocr_utr:             string | null
  ocr_amount:          number | null
  ocr_date:            string | null
  ocr_payee_hint:      string | null
  suggestion_confidence: string | null
  auto_matched:        boolean
  amount_delta:        number | null
  created_at:          string
  thumb_url:           string | null
  suggested_voucher:   VoucherSummary | null
  attached_voucher:    VoucherSummary | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAmt(n: number) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}
function statusLabel(s: string) {
  const map: Record<string, string> = {
    received: 'Received', extracted: 'Processing…', suggested: 'Match found',
    needs_assignment: 'Needs assignment', attached: 'Attached', discarded: 'Discarded',
  }
  return map[s] ?? s
}
function statusClass(s: string): string {
  const map: Record<string, string> = {
    received: css.statusReceived, extracted: css.statusExtracted,
    suggested: css.statusSuggested, needs_assignment: css.statusNeeds,
    attached: css.statusAttached, discarded: css.statusDiscarded,
  }
  return map[s] ?? css.statusReceived
}

// ── IDB → upload sync (reads pending receipts saved by service worker) ────────

async function syncPendingReceipts(authToken: string) {
  if (!('indexedDB' in window)) return
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('pramaana-receipts', 1)
    r.onupgradeneeded = (e) => {
      const d = (e.target as IDBOpenDBRequest).result
      if (!d.objectStoreNames.contains('pending')) d.createObjectStore('pending', { keyPath: 'id', autoIncrement: true })
    }
    r.onsuccess = (e) => res((e.target as IDBOpenDBRequest).result)
    r.onerror = () => rej(r.error)
  })
  const store = db.transaction('pending', 'readwrite').objectStore('pending')
  const all = await new Promise<{ id: number; name: string; type: string; data: ArrayBuffer }[]>((res, rej) => {
    const req = store.getAll()
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
  for (const item of all) {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(item.data)))
    try {
      const r = await fetch('/api/receipt-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ fileBase64: b64, fileName: item.name, fileType: item.type }),
      })
      if (r.ok) {
        const txDel = db.transaction('pending', 'readwrite')
        txDel.objectStore('pending').delete(item.id)
        await new Promise<void>((res) => { txDel.oncomplete = () => res() })
      }
    } catch { /* retry next load */ }
  }
}

// ── Card component ────────────────────────────────────────────────────────────

function InboxCard({ item, onRefresh }: { item: InboxItem; onRefresh: () => void }) {
  const { user } = useAuth()
  const [utrInput,    setUtrInput]    = useState(item.ocr_utr ?? '')
  const [confirming,  setConfirming]  = useState(false)
  const [unmatching,  setUnmatching]  = useState(false)
  const [showUtrEdit, setShowUtrEdit] = useState(false)

  const canUnmatch = item.status === 'attached' && (() => {
    if (!item.auto_matched && !item.attached_voucher) return false
    const confirmedAt = item.attached_voucher ? null : null  // come from item directly
    return true
  })()

  const handleConfirm = async (voucherId: string) => {
    if (!utrInput.trim()) { setShowUtrEdit(true); return }
    setConfirming(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/receipt-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'confirm', inbox_id: item.id, voucher_id: voucherId, utr: utrInput.trim() }),
      })
      const data = await res.json() as { confirmed?: boolean; error?: string }
      if (data.confirmed) { toast.success('Receipt attached — voucher paid ✓'); onRefresh() }
      else toast.error(data.error ?? 'Confirm failed')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Error')
    } finally { setConfirming(false) }
  }

  const handleUnmatch = async () => {
    if (!confirm('Unmatch this receipt? Voucher will revert to awaiting payment.')) return
    setUnmatching(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/receipt-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'unmatch', inbox_id: item.id }),
      })
      const data = await res.json() as { unmatched?: boolean; error?: string }
      if (data.unmatched) { toast.success('Receipt unmatched'); onRefresh() }
      else toast.error(data.error ?? 'Unmatch failed')
    } catch { toast.error('Unmatch failed') }
    finally { setUnmatching(false) }
  }

  return (
    <div className={css.card}>
      {/* Thumbnail */}
      <div>
        {item.thumb_url
          ? <img src={item.thumb_url} alt="receipt" className={css.thumb} />
          : <div className={css.thumbPlaceholder}>📄</div>
        }
      </div>

      {/* Body */}
      <div className={css.body}>
        <div className={css.chips}>
          <span className={`${css.status} ${statusClass(item.status)}`}>{statusLabel(item.status)}</span>
          {item.auto_matched && <span className={css.autoLabel}>Auto-matched</span>}
          {item.ocr_utr  && <span className={`${css.chip} ${css.chipGreen}`}>UTR {item.ocr_utr}</span>}
          {item.ocr_amount != null && <span className={css.chip}>₹{fmtAmt(item.ocr_amount)}</span>}
          {item.ocr_date && <span className={css.chip}>{fmtDate(item.ocr_date)}</span>}
          {item.ocr_payee_hint && <span className={css.chip}>{item.ocr_payee_hint}</span>}
          {item.amount_delta != null && Math.abs(item.amount_delta) > 0 && (
            <span className={`${css.chip} ${css.chipAmber}`}>Δ ₹{fmtAmt(Math.abs(item.amount_delta))}</span>
          )}
          {!item.ocr_utr && (item.status === 'suggested' || item.status === 'needs_assignment') && (
            <span className={`${css.chip} ${css.chipRed}`}>UTR required</span>
          )}
        </div>

        {/* Suggested voucher */}
        {(item.suggested_voucher || item.attached_voucher) && (
          <div className={css.voucherCard}>
            <span className={css.voucherNum}>
              {(item.attached_voucher ?? item.suggested_voucher)!.voucher_number}
            </span>
            <span className={css.voucherAmt}>
              ₹{fmtAmt((item.attached_voucher ?? item.suggested_voucher)!.amount)}
            </span>
            {item.suggestion_confidence && (
              <span className={css.chip}>{item.suggestion_confidence} confidence</span>
            )}
          </div>
        )}

        {/* UTR input when missing */}
        {(showUtrEdit || (!item.ocr_utr && item.status === 'suggested')) && item.status !== 'attached' && (
          <input
            type="text" className={`${css.utrInput} ${!utrInput.trim() ? css.required : ''}`}
            placeholder="Enter UTR / transaction reference"
            value={utrInput} onChange={e => setUtrInput(e.target.value)}
          />
        )}

        <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
          {fmtDate(item.created_at)}
          {item.company_id && <span style={{ marginLeft: '0.5rem' }}>{item.company_id.slice(0, 8)}</span>}
        </span>
      </div>

      {/* Actions */}
      <div className={css.actions}>
        {item.status === 'suggested' && item.suggested_voucher && (
          <>
            <button
              className={css.btnConfirm}
              disabled={confirming || !utrInput.trim()}
              onClick={() => handleConfirm(item.suggested_voucher!.id)}
            >
              {confirming ? <Loader2 size={13} className={css.spin} /> : null}
              {confirming ? 'Confirming…' : 'Confirm'}
            </button>
            <button className={css.btnSecondary}
              onClick={() => setShowUtrEdit(v => !v)}>
              Edit UTR
            </button>
          </>
        )}
        {item.status === 'needs_assignment' && (
          <button className={css.btnSecondary}
            onClick={() => toast.info('Voucher picker — coming soon')}>
            Assign to voucher…
          </button>
        )}
        {item.status === 'attached' && (
          <button
            className={`${css.btnSecondary} ${css.btnDanger}`}
            disabled={unmatching}
            onClick={handleUnmatch}
          >
            {unmatching ? <Loader2 size={13} className={css.spin} /> : null}
            Unmatch
          </button>
        )}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReceiptInbox() {
  const { user } = useAuth()
  const [items,   setItems]   = useState<InboxItem[]>([])
  const [loading, setLoading] = useState(true)
  const syncedRef = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/receipt-inbox', {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      })
      if (!res.ok) throw new Error('Failed to load inbox')
      const data = await res.json() as { items: InboxItem[] }
      setItems(data.items)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to load inbox')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    if (!user || syncedRef.current) return
    syncedRef.current = true
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.access_token) syncPendingReceipts(session.access_token)
    })
  }, [user])

  useEffect(() => { load() }, [load])

  // Show toast for ?shared=1 landing from share target
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('shared') === '1') {
      toast.success('✓ Receipt received — processing…')
      window.history.replaceState({}, '', '/receipts/inbox')
    }
  }, [])

  return (
    <div className={css.page}>
      <div className={css.pageHeader}>
        <Receipt size={20} style={{ color: 'var(--accent)' }} />
        <h1 className={css.pageTitle}>Receipt Inbox</h1>
        <span className={css.headerNote}>Receipts shared from your payment apps</span>
        <button className={css.btnSecondary} onClick={load} title="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      {loading && (
        <div className={css.emptyState}>
          <Loader2 size={32} className={css.spin} />
          <span>Loading…</span>
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className={css.emptyState}>
          <span className={css.emptyIcon}>📭</span>
          <span>No receipts yet</span>
          <span style={{ fontSize: '0.75rem' }}>
            Share a payment screenshot from GPay, PhonePe, or your bank app →
            tap Share → Pramaana
          </span>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className={css.list}>
          {items.map(item => (
            <InboxCard key={item.id} item={item} onRefresh={load} />
          ))}
        </div>
      )}
    </div>
  )
}
