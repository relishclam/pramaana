/**
 * Pramaana teal logo mark — used when logo.png is not present.
 * Replace by placing logo.png in pramaana/public/ to use the real image.
 */
export function PramaanaLogoMark({ size = 48 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Pramaana"
    >
      <rect width="48" height="48" rx="10" fill="rgba(74,158,158,0.18)" />
      {/* Bar chart base */}
      <rect x="10" y="34" width="5" height="6" rx="1" fill="#4a9e9e" opacity="0.6" />
      <rect x="17" y="29" width="5" height="11" rx="1" fill="#4a9e9e" opacity="0.75" />
      <rect x="24" y="24" width="5" height="16" rx="1" fill="#4a9e9e" opacity="0.9" />
      {/* Check arc — top right */}
      <path
        d="M28 10 C28 10 36 10 36 18 C36 24 30 26 28 26"
        stroke="#4a9e9e"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      {/* Check mark */}
      <path
        d="M30 17 L33 20 L38 13"
        stroke="#4a9e9e"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

/** Full logo: mark + wordmark */
export function PramaanaLogo({ size = 48 }: { size?: number }) {
  const fontSize = size * 0.58
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
      <PramaanaLogoMark size={size} />
      <span
        style={{
          fontFamily: "'Fraunces', Georgia, serif",
          fontSize: `${fontSize}px`,
          fontWeight: 600,
          color: '#4a9e9e',
          letterSpacing: '-0.02em',
          lineHeight: 1,
        }}
      >
        Pramaana
      </span>
    </div>
  )
}
