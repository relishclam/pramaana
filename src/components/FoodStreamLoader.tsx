import styles from './FoodStreamLoader.module.css'

interface Props {
  label?: string
  speed?: number   // seconds — 2.4 to 6.0, default 3.6
  theme?: 'deep' | 'light'
}

const DEEP  = 'linear-gradient(160deg,#071b2b 0%,#0a2a40 55%,#0e3a52 100%)'
const LIGHT = 'linear-gradient(160deg,#eaf7fb 0%,#d3edf4 60%,#bfe6f0 100%)'

export default function FoodStreamLoader({ label = 'Loading', speed = 3.6, theme = 'deep' }: Props) {
  return (
    <div
      className={styles.root}
      style={{ background: theme === 'light' ? LIGHT : DEEP }}
    >
      {/* Radial teal glow */}
      <div className={styles.glow} />

      {/* Logo + ripples */}
      <div className={styles.logoWrap}>
        <div className={styles.ripple1} />
        <div className={styles.ripple2} />

        <div
          className={styles.bob}
          style={{ '--fs-bob-dur': `${speed * 1.8}s` } as React.CSSProperties}
        >
          <div className={styles.shadow}>
            <img
              src="/FoodStream_Wave.png"
              alt="FoodStream"
              className={styles.logo}
              style={{ '--fs-rev-dur': `${speed}s` } as React.CSSProperties}
            />
          </div>
        </div>
      </div>

      {/* Label + dots + progress bar */}
      <div className={styles.bottom}>
        <div className={styles.labelRow}>
          <span className={styles.label}>{label}</span>
          <span className={styles.dots}>
            <i className={styles.dot} style={{ animationDelay: '0s' }} />
            <i className={styles.dot} style={{ animationDelay: '0.2s' }} />
            <i className={styles.dot} style={{ animationDelay: '0.4s' }} />
          </span>
        </div>

        <div className={styles.barTrack}>
          <div className={styles.bar} />
        </div>
      </div>

      {/* Brand watermark */}
      <div className={styles.watermark}>FoodStream</div>
    </div>
  )
}
