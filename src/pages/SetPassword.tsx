import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Eye, EyeOff, KeyRound } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import styles from './Login.module.css'

interface FormValues {
  password: string
  confirm: string
}

export default function SetPassword() {
  const navigate = useNavigate()
  const { clearNeedsPasswordSet } = useAuth()
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm,  setShowConfirm]  = useState(false)
  const [submitting,   setSubmitting]   = useState(false)

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>()

  const passwordValue = watch('password', '')

  const onSubmit = async (values: FormValues) => {
    setSubmitting(true)
    const { error } = await supabase.auth.updateUser({ password: values.password })
    if (error) {
      toast.error(error.message)
      setSubmitting(false)
      return
    }
    clearNeedsPasswordSet()
    toast.success('Password set — welcome to Pramaana!')
    navigate('/', { replace: true })
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logoWrap}>
          <img src="/Logo_3D.png" alt="Pramaana" className={styles.logo} />
        </div>

        <p className={styles.tagline}>Set your password to continue</p>

        <form className={styles.form} onSubmit={handleSubmit(onSubmit)} noValidate>
          {/* New Password */}
          <div className={styles.field}>
            <label htmlFor="sp-password" className={styles.label}>New Password</label>
            <div className={styles.passwordWrap}>
              <input
                id="sp-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                autoFocus
                className={`${styles.input} ${errors.password ? styles.inputError : ''}`}
                placeholder="Min. 8 characters"
                {...register('password', {
                  required: 'Password is required',
                  minLength: { value: 8, message: 'Minimum 8 characters' },
                })}
              />
              <button
                type="button"
                className={styles.eyeBtn}
                onClick={() => setShowPassword(v => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {errors.password && (
              <span className={styles.error}>{errors.password.message}</span>
            )}
          </div>

          {/* Confirm Password */}
          <div className={styles.field}>
            <label htmlFor="sp-confirm" className={styles.label}>Confirm Password</label>
            <div className={styles.passwordWrap}>
              <input
                id="sp-confirm"
                type={showConfirm ? 'text' : 'password'}
                autoComplete="new-password"
                className={`${styles.input} ${errors.confirm ? styles.inputError : ''}`}
                placeholder="Repeat password"
                {...register('confirm', {
                  required: 'Please confirm your password',
                  validate: val => val === passwordValue || 'Passwords do not match',
                })}
              />
              <button
                type="button"
                className={styles.eyeBtn}
                onClick={() => setShowConfirm(v => !v)}
                aria-label={showConfirm ? 'Hide password' : 'Show password'}
              >
                {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {errors.confirm && (
              <span className={styles.error}>{errors.confirm.message}</span>
            )}
          </div>

          <button type="submit" className={styles.submitBtn} disabled={submitting}>
            {submitting ? (
              <span className={styles.spinner} />
            ) : (
              <>
                <KeyRound size={16} />
                Set Password &amp; Continue
              </>
            )}
          </button>
        </form>

        <p className={styles.footer}>Developed &amp; Maintained by FoodStream Ltd, Hong Kong</p>
      </div>
    </div>
  )
}
