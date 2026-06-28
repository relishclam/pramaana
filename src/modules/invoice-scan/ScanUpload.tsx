import { useState, useRef, useCallback, useEffect, DragEvent, ChangeEvent } from 'react'
import { useNavigate }     from 'react-router-dom'
import { Upload, X, FileText, AlertCircle, CheckCircle, ScanLine, Info, Camera, Smartphone } from 'lucide-react'
import { toast }           from 'sonner'
import { useAuth }         from '@/contexts/AuthContext'
import { useOcr }          from './hooks/useOcr'
import QRRelayModal        from '@/components/QRRelayModal'
import css                 from './ScanUpload.module.css'

type InvoiceType = 'purchase' | 'sale'

function formatBytes(bytes: number): string {
  if (bytes < 1024)        return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export default function ScanUpload() {
  const { user }  = useAuth()
  const navigate  = useNavigate()
  const companyId   = user?.activeCompany?.id   ?? ''
  const companyCode = user?.activeCompany?.code  ?? ''
  const userId      = user?.id                   ?? ''

  const [invoiceType, setInvoiceType] = useState<InvoiceType>('purchase')
  const [file,        setFile]        = useState<File | null>(null)
  const [previewUrl,  setPreviewUrl]  = useState<string | null>(null)
  const [dragOver,    setDragOver]    = useState(false)
  const [scanId,      setScanId]      = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const { loading, error, runOcr, reset } = useOcr()

  // ── File selection ────────────────────────────────────────────────────────
  const acceptFile = useCallback((f: File) => {
    const MAX = 5 * 1024 * 1024
    if (f.size > MAX) {
      toast.error('File exceeds 5 MB. Please compress or use a smaller file.')
      return
    }
    const ALLOWED = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'])
    if (!ALLOWED.has(f.type)) {
      toast.error('Only PDF, JPG, and PNG files are accepted.')
      return
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    const url = f.type.startsWith('image/') ? URL.createObjectURL(f) : null
    setFile(f)
    setPreviewUrl(url)
    setScanId(null)
    reset()
  }, [previewUrl, reset])

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) acceptFile(f)
    e.target.value = ''
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) acceptFile(f)
  }

  const clearFile = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(null)
    setPreviewUrl(null)
    setScanId(null)
    reset()
  }

  // ── Camera / Scanner ──────────────────────────────────────────────────────
  const [cameraOpen,      setCameraOpen]      = useState(false)
  const [cameraLoading,   setCameraLoading]   = useState(false)
  const [cameraError,     setCameraError]     = useState<string | null>(null)
  const [devices,         setDevices]         = useState<MediaDeviceInfo[]>([])
  const [selectedDevice,  setSelectedDevice]  = useState<string>('')
  const [streamReady,     setStreamReady]     = useState(false)
  const streamRef  = useRef<MediaStream | null>(null)
  const videoRef   = useRef<HTMLVideoElement>(null)
  const canvasRef  = useRef<HTMLCanvasElement>(null)

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setStreamReady(false)
  }, [])

  const startStream = useCallback(async (deviceId: string) => {
    stopStream()
    setCameraLoading(true)
    setCameraError(null)
    setStreamReady(false)
    try {
      const constraints: MediaStreamConstraints = {
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' },
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play()
          setStreamReady(true)
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Camera access denied'
      setCameraError(
        msg.includes('Permission') || msg.includes('NotAllowed')
          ? 'Camera permission denied. Allow camera access in your browser settings.'
          : `Could not start camera: ${msg}`
      )
    } finally {
      setCameraLoading(false)
    }
  }, [stopStream])

  const openCamera = async () => {
    setCameraOpen(true)
    setCameraError(null)
    setCameraLoading(true)
    try {
      // Enumerate devices — requires a brief permission probe first
      await navigator.mediaDevices.getUserMedia({ video: true }).then(s => s.getTracks().forEach(t => t.stop()))
      const all = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = all.filter(d => d.kind === 'videoinput')
      setDevices(videoDevices)
      const firstId = videoDevices[0]?.deviceId ?? ''
      setSelectedDevice(firstId)
      await startStream(firstId)
    } catch (err: unknown) {
      setCameraLoading(false)
      const msg = err instanceof Error ? err.message : 'Camera unavailable'
      setCameraError(
        msg.includes('Permission') || msg.includes('NotAllowed')
          ? 'Camera permission denied. Allow camera access in your browser settings and reload.'
          : `Camera unavailable: ${msg}`
      )
    }
  }

  const handleDeviceChange = async (deviceId: string) => {
    setSelectedDevice(deviceId)
    await startStream(deviceId)
  }

  const closeCamera = useCallback(() => {
    stopStream()
    setCameraOpen(false)
    setCameraError(null)
    setDevices([])
    setStreamReady(false)
  }, [stopStream])

  const captureFrame = () => {
    const video  = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || !streamReady) return

    canvas.width  = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    canvas.toBlob(blob => {
      if (!blob) { toast.error('Capture failed — try again'); return }
      const captured = new File(
        [blob],
        `scan-${new Date().toLocaleDateString('en-IN').replace(/\//g, '-')}.jpg`,
        { type: 'image/jpeg' },
      )
      closeCamera()
      acceptFile(captured)
    }, 'image/jpeg', 0.92)
  }

  // Stop stream when component unmounts
  useEffect(() => () => stopStream(), [stopStream])

  // ── Run OCR ───────────────────────────────────────────────────────────────
  const handleScan = async () => {
    if (!file || !companyId) return

    const result = await runOcr({ file, invoiceType, companyId, companyCode, userId })
    if (!result) return

    if (result.scanId) {
      setScanId(result.scanId)
      toast.success('Invoice scanned and saved to inbox.')
    } else {
      toast.warning('Invoice scanned but could not be saved (DB write failed).')
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={css.wrap}>
      <h1 className={css.heading}>Scan Invoice</h1>
      <p className={css.subheading}>Upload a purchase or sales invoice to extract fields automatically.</p>

      {/* Type selector */}
      <div className={css.typeTabs}>
        {(['purchase', 'sale'] as InvoiceType[]).map(t => (
          <button
            key={t}
            className={`${css.typeTab}${invoiceType === t ? ` ${css.typeTabActive}` : ''}`}
            onClick={() => setInvoiceType(t)}
          >
            {t === 'purchase' ? 'Purchase' : 'Sales'}
          </button>
        ))}
      </div>

      {/* Drop zone + camera capture (hidden when processing or done) */}
      {!loading && !scanId && (
        <>
          {/* ── Camera capture panel ─────────────────────────────────────── */}
          {cameraOpen ? (
            <div className={css.cameraWrap}>
              <div className={css.cameraHeader}>
                <span className={css.cameraTitle}>
                  <Camera size={13} /> Camera / Scanner
                </span>
                {devices.length > 1 && (
                  <select
                    className={css.deviceSelect}
                    value={selectedDevice}
                    onChange={e => handleDeviceChange(e.target.value)}
                  >
                    {devices.map(d => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Camera ${devices.indexOf(d) + 1}`}
                      </option>
                    ))}
                  </select>
                )}
                <button className={css.cameraCloseBtn} onClick={closeCamera} aria-label="Close camera">
                  <X size={14} />
                </button>
              </div>

              {cameraLoading && (
                <div className={css.cameraLoading}>
                  <div className={css.cameraSpinner} />
                  <span>Starting camera…</span>
                </div>
              )}

              {cameraError && (
                <div className={css.cameraError}>
                  <AlertCircle size={28} style={{ color: 'var(--error)', flexShrink: 0 }} />
                  <span>
                    <strong>Camera unavailable</strong>
                    {cameraError}
                  </span>
                </div>
              )}

              {!cameraLoading && !cameraError && (
                /* eslint-disable-next-line jsx-a11y/media-has-caption */
                <video
                  ref={videoRef}
                  className={css.cameraVideo}
                  autoPlay
                  playsInline
                  muted
                />
              )}

              {/* Hidden canvas used for frame capture */}
              <canvas ref={canvasRef} style={{ display: 'none' }} />

              <div className={css.cameraFooter}>
                <button
                  className={css.captureBtn}
                  onClick={captureFrame}
                  disabled={!streamReady || cameraLoading}
                >
                  <Camera size={15} /> Capture Frame
                </button>
              </div>
            </div>
          ) : (
            /* ── Standard drop zone ──────────────────────────────────────── */
            !file ? (
              <div
                className={`${css.dropZone}${dragOver ? ` ${css.dropZoneActive}` : ''}`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && fileInputRef.current?.click()}
                aria-label="Upload invoice file"
              >
                <Upload size={28} className={css.dropIcon} />
                <p className={css.dropTitle}>Drop invoice here or click to browse</p>
                <p className={css.dropSub}>PDF, JPG or PNG · Max 5 MB</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  className={css.hiddenInput}
                  onChange={onInputChange}
                />
              </div>
            ) : (
              <div className={css.preview}>
                {previewUrl ? (
                  <img src={previewUrl} alt="Invoice preview" className={css.previewImg} />
                ) : (
                  <div className={css.previewFile}>
                    <FileText size={20} />
                    <span>
                      <span className={css.previewFileName}>{file.name}</span>
                      <span className={css.previewSize}> · {formatBytes(file.size)}</span>
                    </span>
                  </div>
                )}
                {file.type === 'application/pdf' && (
                  <div className={css.pdfNote}>
                    <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                    GPT-4o will scan all pages. For multi-page PDFs (e.g. with e-way bill), only the primary invoice page is relevant.
                  </div>
                )}
                <div className={css.previewActions}>
                  <button className={css.clearBtn} onClick={clearFile}>
                    <X size={13} /> Clear
                  </button>
                  <span className={css.previewSize}>{formatBytes(file.size)}</span>
                </div>
              </div>
            )
          )}

          {/* ── Alternative input methods ─────────────────────────────────── */}
          {!file && !cameraOpen && (
            <div className={css.altSources}>
              <div className={css.altDivider} />
              <span className={css.altDividerText}>or use</span>
              <div className={css.altDivider} />
              <button
                type="button"
                className={css.altBtn}
                onClick={openCamera}
                title="Capture directly from a connected webcam or document scanner"
              >
                <Camera size={13} /> Camera / Scanner
              </button>
              <QRRelayModal
                companyId={companyId}
                onFileReceived={f => { acceptFile(f) }}
              />
            </div>
          )}

          {error && (
            <div className={css.errorBox}>
              <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              {error}
            </div>
          )}

          {file && (
            <button
              className={css.scanBtn}
              onClick={handleScan}
              disabled={!file || loading}
            >
              <ScanLine size={17} />
              Scan Invoice
            </button>
          )}
        </>
      )}

      {/* Processing */}
      {loading && (
        <div className={css.processing}>
          <div className={css.spinner} />
          <p className={css.processingText}>Extracting invoice data…</p>
          <p className={css.processingSubtext}>GPT-4o is reading the invoice. This usually takes 5–15 seconds.</p>
        </div>
      )}

      {/* Success */}
      {!loading && scanId && (
        <>
          <div className={css.successBox}>
            <CheckCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            Invoice scanned and saved to inbox.
          </div>
          <div className={css.successActions}>
            <button
              className={css.primaryBtn}
              onClick={() => navigate(`/invoices/inbox/${scanId}`)}
            >
              Review &amp; Create Voucher
            </button>
            <button
              className={css.secondaryBtn}
              onClick={() => { clearFile(); setScanId(null) }}
            >
              Scan Another
            </button>
          </div>
        </>
      )}
    </div>
  )
}

                  GPT-4o will scan all pages. For multi-page PDFs (e.g. with e-way bill), only the primary invoice page is relevant.
                </div>
              )}
              <div className={css.previewActions}>
                <button className={css.clearBtn} onClick={clearFile}>
                  <X size={13} /> Clear
                </button>
                <span className={css.previewSize}>{formatBytes(file.size)}</span>
              </div>
            </div>
          )}

          {error && (
            <div className={css.errorBox}>
              <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              {error}
            </div>
          )}

          {file && (
            <button
              className={css.scanBtn}
              onClick={handleScan}
              disabled={!file || loading}
            >
              <ScanLine size={17} />
              Scan Invoice
            </button>
          )}
        </>
      )}

      {/* Processing */}
      {loading && (
        <div className={css.processing}>
          <div className={css.spinner} />
          <p className={css.processingText}>Extracting invoice data…</p>
          <p className={css.processingSubtext}>GPT-4o is reading the invoice. This usually takes 5–15 seconds.</p>
        </div>
      )}

      {/* Success */}
      {!loading && scanId && (
        <>
          <div className={css.successBox}>
            <CheckCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            Invoice scanned and saved to inbox.
          </div>
          <div className={css.successActions}>
            <button
              className={css.primaryBtn}
              onClick={() => navigate(`/invoices/inbox/${scanId}`)}
            >
              Review &amp; Create Voucher
            </button>
            <button
              className={css.secondaryBtn}
              onClick={() => { clearFile(); setScanId(null) }}
            >
              Scan Another
            </button>
          </div>
        </>
      )}
    </div>
  )
}
