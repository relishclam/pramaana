import styles from './FoodStreamMini.module.css'

interface Props {
  label?: string   // optional text below the bar; defaults to 'Fetching data…'
  size?: number    // logo width in px; default 80
}

export default function FoodStreamMini({ label = 'Fetching data…', size = 80 }: Props) {
  return (
    <div className={styles.wrap}>
      <div className={styles.shadow} style={{ width: size, height: size }}>
        <img
          src="/FoodStream_Wave.png"
          alt="Loading"
          className={styles.logo}
          style={{ width: size, height: size }}
        />
      </div>

      <div className={styles.barTrack} style={{ width: Math.round(size * 1.5) }}>
        <div className={styles.bar} />
      </div>

      {label && <span className={styles.label}>{label}</span>}
    </div>
  )
}
