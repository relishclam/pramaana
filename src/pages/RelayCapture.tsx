/**
 * RelayCapture — public mobile page.
 * Receives ?path=&token= in the URL, allows user to take/pick a photo,
 * uploads it to Supabase Storage via the pre-signed upload URL.
 * No authentication required — the signed token authorises the specific upload.
 */
import { useState, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Camera, ImagePlus, Check, AlertCircle, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import styles from './RelayCapture.module.css'

type Status = 'idle' | 'uploading' | 'done' | 'error'

export default function RelayCapture() {
  const [params] = useSearchParams()
  const path  = params.get('path')  ?? ''
  const token = params.get('token') ?? ''

  const [status,   setStatus]   = useState<Status>('idle')
  const [preview,  setPreview]  = useState<string>('')
  const [errMsg,   setErrMsg]   = useState('')

  const cameraRef  = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)

  // ── Invalid / expired link ────────────────────────────────────────────────
  if (!path || !token) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <AlertCircle size={36} className={styles.errorIcon} />
          <h2 className={styles.title}>Link is invalid or has expired</h2>
          <p className={styles.sub}>Go back to Pramaana and generate a new QR code.</p>
        </div>
      </div>
    )
  }

  // ── Upload a File ─────────────────────────────────────────────────────────
  const upload = async (file: File) => {
    // Show preview immediately
    const reader = new FileReader()
    reader.onload = ev => setPreview(ev.target?.result as string)
    reader.readAsDataURL(file)

    setStatus('uploading')
    setErrMsg('')

    const { error } = await supabase.storage
      .from('voucher-attachments')
      .uploadToSignedUrl(path, token, file, {
        contentType: file.type || 'image/jpeg',
        upsert: false,
      })

    if (error) {
      setStatus('error')
      setErrMsg(error.message)
      return
    }

    setStatus('done')
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) upload(file)
  }

  const retry = () => {
    setStatus('idle')
    setPreview('')
    setErrMsg('')
    if (cameraRef.current)  cameraRef.current.value  = ''
    if (galleryRef.current) galleryRef.current.value = ''
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.page}>
      <div className={styles.card}>

        {/* Logo */}
        <div className={styles.logo}>Pramaana</div>

        {/* Idle — pick a source */}
        {status === 'idle' && (
          <>
            <h1 className={styles.title}>Attach a photo</h1>
            <p className={styles.sub}>Take a photo of the bill, invoice, or receipt</p>

            {/* Camera capture */}
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => cameraRef.current?.click()}
            >
              <Camera size={22} />
              Use Camera
            </button>

            {/* Gallery picker */}
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => galleryRef.current?.click()}
            >
              <ImagePlus size={18} />
              Choose from Gallery
            </button>

            <p className={styles.hint}>JPG, PNG, PDF · max 10 MB</p>

            {/* Hidden inputs */}
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={handleFileInput}
            />
            <input
              ref={galleryRef}
              type="file"
              accept="image/*,application/pdf"
              style={{ display: 'none' }}
              onChange={handleFileInput}
            />
          </>
        )}

        {/* Uploading */}
        {status === 'uploading' && (
          <>
            {preview && (
              <img src={preview} alt="Preview" className={styles.preview} />
            )}
            <div className={styles.statusRow}>
              <Loader2 size={20} className={styles.spin} />
              <span>Uploading…</span>
            </div>
          </>
        )}

        {/* Done */}
        {status === 'done' && (
          <>
            {preview && (
              <img src={preview} alt="Preview" className={styles.preview} />
            )}
            <div className={`${styles.statusRow} ${styles.success}`}>
              <Check size={20} />
              <span>Uploaded — you can close this page</span>
            </div>
            <button type="button" className={styles.secondaryBtn} onClick={retry}>
              Add another photo
            </button>
          </>
        )}

        {/* Error */}
        {status === 'error' && (
          <>
            <AlertCircle size={32} className={styles.errorIcon} />
            <p className={styles.errorText}>{errMsg || 'Upload failed'}</p>
            <p className={styles.sub}>The QR may have expired. Go back to Pramaana and generate a new one.</p>
            <button type="button" className={styles.secondaryBtn} onClick={retry}>
              Try again
            </button>
          </>
        )}

      </div>
    </div>
  )
}
