// ── XLSX parser — header detection + data extraction via SheetJS ──────────────
// Server-side only. Never imported in client components.
// Dynamic import prevents Vercel esbuild from bundling xlsx at module-init time.

/**
 * Parse an XLSX file buffer into rows of string arrays.
 * Uses SheetJS. Handles HDFC-style files with 15+ letterhead rows before headers.
 */
export async function parseXLSX(buffer: ArrayBuffer): Promise<string[][]> {
  const XLSX = await import('xlsx')

  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false, raw: false })

  // Use first sheet
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return []

  const sheet = workbook.Sheets[sheetName]

  // Convert to array of arrays (all values as strings)
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,          // return arrays, not objects
    defval: '',         // empty cells → empty string
    raw: false,         // format numbers/dates as strings
    blankrows: true,    // keep blank rows so row indices are stable
  }) as unknown[][]

  const MAX_ROWS = 50_000
  if (raw.length > MAX_ROWS) {
    throw new Error(`Statement has ${raw.length} rows — maximum supported is ${MAX_ROWS}`)
  }

  return raw.map(row =>
    row.map(cell => {
      if (cell === null || cell === undefined) return ''
      // SheetJS may return an Excel serial number string (e.g. "46113") if a cell has no
      // explicit date format — normaliseDate handles this by returning null, skipping the row.
      return String(cell).trim()
    })
  )
}
