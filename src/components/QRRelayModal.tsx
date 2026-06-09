/**
 * QRRelayModal — desktop-side "send to phone camera" widget.
 *
 * Flow:
 *  1. User clicks "Send to Phone Camera" button.
 *  2. We call supabase.storage.createSignedUploadUrl() for a temporary relay path.
 *  3. The signed token + path are encoded into a /relay?path=…&token=… URL.
 *  4. A QR code of that URL is shown on screen.
 *  5. User scans QR on phone → phone opens RelayCapture page → takes photo → uploads.
 *  6. Desktop polls storage every 2.5 s for the file.
 *  7. When found: download → create File object → call onFileReceived() → cleanup.
 *
 * Path layout (stays within existing RLS):
 *   {companyId}/relay/{sessionId}   ← signed upload target
 *   {companyId}/relay/              ← polled via list()
 */
import { useState, useEffect, useRef } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Smartphone, X, Check, Loader2, AlertCircle, RefreshCw } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import styles from './QRRelayModal.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

type Stage =
  | 'idle'        // button not yet clicked
  | 'generating'  // calling createSignedUploadUrl
  | 'waiting'     // QR shown, waiting for phone upload
  | 'received'    // file downloaded, passing to parent
  | 'expired'     // 10-minute timer ran out
  | 'error'       // API error

const EXPIRY_MS   = 10 * 60 * 1000   // 10 minutes (Supabase signed URL default)
const POLL_MS     = 2500

interface Props {
  companyId:      string
  onFileReceived: (file: File) => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function QRRelayModal({ companyId, onFileReceived }: Props) {
  const [open,      setOpen]      = useState(false)
  const [stage,     setStage]     = useState<Stage>('idle')
  const [qrUrl,     setQrUrl]     = useState('')
  const [timeLeft,  setTimeLeft]  = useState(EXPIRY_MS)
  const [errMsg,    setErrMsg]    = useState('')

  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null)
  const countdownRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const relayFolderRef = useRef('')   // "{companyId}/relay"
  const sessionIdRef   = useRef('')   // the unique ID for this session

  const clearTimers = () => {
    if (pollRef.current)      clearInterval(pollRef.current)
    if (countdownRef.current) clearInterval(countdownRef.current)
    pollRef.current      = null
    countdownRef.current = null
  }

  // ── Generate signed upload URL and start polling ──────────────────────────
  const startSession = async () => {
    clearTimers()
    setStage('generating')
    setErrMsg('')
    setTimeLeft(EXPIRY_MS)

    const sessionId  = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
    const relayFolder = `${companyId}/relay`
    const uploadPath  = `${relayFolder}/${sessionId}`   // full path of the file
    relayFolderRef.current  = relayFolder
    sessionIdRef.current    = sessionId

    const { data, error } = await supabase.storage
      .from('voucher-attachments')
      .createSignedUploadUrl(uploadPath)

    if (error || !data) {
      setStage('error')
      setErrMsg(error?.message ?? 'Failed to create upload link')
      return
    }

    // Build the URL the phone will open
    const relayPageUrl =
      `${window.location.origin}/relay` +
      `?path=${encodeURIComponent(data.path)}` +
      `&token=${encodeURIComponent(data.token)}`

    setQrUrl(relayPageUrl)
    setStage('waiting')

    // ── Poll storage ─────────────────────────────────────────────────────
    pollRef.current = setInterval(async () => {
      const { data: files, error: listErr } = await supabase.storage
        .from('voucher-attachments')
        .list(relayFolder, { search: sessionId })

      if (listErr || !files?.length) return

      // File found — stop polling, download, create File object, notify parent
      clearTimers()

      const { data: blob, error: dlErr } = await supabase.storage
        .from('voucher-attachments')
        .download(uploadPath)

      if (dlErr || !blob) {
        setStage('error')
        setErrMsg('File found but failed to retrieve it.')
        return
      }

      const file = new File(
        [blob],
        `relay-${new Date().toLocaleDateString('en-IN').replace(/\//g, '-')}.jpg`,
        { type: blob.type || 'image/jpeg' },
      )

      setStage('received')
      onFileReceived(file)

      // Clean up relay file from storage (fire-and-forget)
      supabase.storage.from('voucher-attachments').remove([uploadPath])

      // Auto-close after showing success
      setTimeout(() => setOpen(false), 2200)
    }, POLL_MS)

    // ── Countdown ─────────────────────────────────────────────────────────
    countdownRef.current = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1000) {
          clearTimers()
          setStage('expired')
          return 0
        }
        return prev - 1000
      })
    }, 1000)
  }

  // ── Open/close ────────────────────────────────────────────────────────────
  const handleOpen = () => {
    setOpen(true)
    startSession()
  }

  const handleClose = () => {
    clearTimers()
    setOpen(false)
    setStage('idle')
  }

  // Cleanup on unmount
  useEffect(() => clearTimers, [])

  // ── Format countdown ──────────────────────────────────────────────────────
  const mins = Math.floor(timeLeft / 60000)
  const secs = Math.floor((timeLeft % 60000) / 1000)
  const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Trigger button */}
      <button
        type="button"
        className={styles.trigger}
        onClick={handleOpen}
        title="Scan a QR on your phone to take a photo"
      >
        <Smartphone size={14} />
        Send to Phone Camera
      </button>

      {/* Modal */}
      {open && (
        <div
          className={styles.overlay}
          onClick={e => { if (e.target === e.currentTarget) handleClose() }}
        >
          <div className={styles.modal}>

            {/* Header */}
            <div className={styles.header}>
              <span className={styles.headerTitle}>
                <Smartphone size={15} /> Scan with your phone
              </span>
              <button className={styles.closeBtn} onClick={handleClose} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div className={styles.body}>

              {/* Generating */}
              {stage === 'generating' && (
                <div className={styles.centered}>
                  <Loader2 size={32} className={styles.spin} />
                  <p className={styles.note}>Generating secure QR…</p>
                </div>
              )}

              {/* Waiting — QR displayed */}
              {stage === 'waiting' && (
                <>
                  <div className={styles.qrFrame}>
                    <QRCodeSVG
                      value={qrUrl}
                      size={200}
                      bgColor="#ffffff"
                      fgColor="#0e1117"
                      level="M"
                    />
                  </div>

                  <ol className={styles.steps}>
                    <li>Open your phone camera and scan the QR code</li>
                    <li>Take a photo of the bill or receipt</li>
                    <li>Photo uploads automatically — this screen updates</li>
                  </ol>

                  <div className={styles.waitRow}>
                    <Loader2 size={13} className={styles.spin} />
                    <span className={styles.waitLabel}>Waiting for upload…</span>
                    <span className={`${styles.timer} ${timeLeft < 60000 ? styles.timerWarn : ''}`}>
                      {timeStr}
                    </span>
                  </div>
                </>
              )}

              {/* Received */}
              {stage === 'received' && (
                <div className={styles.centered}>
                  <div className={styles.successCircle}>
                    <Check size={28} />
                  </div>
                  <p className={styles.successText}>Photo received!</p>
                  <p className={styles.note}>Added to your attachments</p>
                </div>
              )}

              {/* Expired */}
              {stage === 'expired' && (
                <div className={styles.centered}>
                  <AlertCircle size={28} className={styles.warnIcon} />
                  <p className={styles.warnText}>QR code expired</p>
                  <button className={styles.retryBtn} onClick={startSession}>
                    <RefreshCw size={13} /> Generate new QR
                  </button>
                </div>
              )}

              {/* Error */}
              {stage === 'error' && (
                <div className={styles.centered}>
                  <AlertCircle size={28} className={styles.errIcon} />
                  <p className={styles.errText}>{errMsg || 'Something went wrong'}</p>
                  <button className={styles.retryBtn} onClick={startSession}>
                    <RefreshCw size={13} /> Try again
                  </button>
                </div>
              )}

            </div>
          </div>
        </div>
      )}
    </>
  )
}
