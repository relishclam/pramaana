// ── CSV parser — handles encoding, BOM, delimiters, quoting edge cases ────────

/**
 * Parse CSV/TSV text into rows of string arrays.
 * Handles: BOM, mixed line endings, quoted fields with commas, empty rows.
 */
export function parseCSV(raw: string): string[][] {
  // BOM stripping handled by decodeText; strip here only for callers that skip decodeText
  const text = raw.replace(/^\uFEFF/, '')

  // Normalise line endings
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  // Auto-detect delimiter: sum tabs vs commas across first 10 non-empty lines to
  // avoid false-positive from a single-comma metadata header (e.g. "Bank Name: ABC, Branch: XYZ")
  let delimiter = ','
  const sampleLines = lines.filter(l => l.trim().length > 0).slice(0, 10)
  let totalTabs = 0, totalCommas = 0
  for (const l of sampleLines) {
    totalTabs   += (l.match(/\t/g) ?? []).length
    totalCommas += (l.match(/,/g) ?? []).length
  }
  if (totalTabs > totalCommas) delimiter = '\t'

  return lines.map(line => parseCSVLine(line, delimiter))
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let i = 0

  if (line.length === 0) {
    cells.push('')
    return cells
  }

  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field
      let cell = ''
      i++ // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          cell += '"'
          i += 2
        } else if (line[i] === '"') {
          i++ // skip closing quote
          break
        } else {
          cell += line[i++]
        }
      }
      cells.push(cell)
      // Skip delimiter after closing quote
      if (line[i] === delimiter) {
        i++
        // Trailing delimiter means one more empty cell
        if (i === line.length) cells.push('')
      }
    } else {
      // Unquoted field
      const end = line.indexOf(delimiter, i)
      if (end === -1) {
        cells.push(line.slice(i))
        i = line.length
      } else {
        cells.push(line.slice(i, end))
        i = end + 1
        // Trailing delimiter — push the implied empty cell
        if (i === line.length) cells.push('')
      }
    }
  }

  return cells
}

/**
 * Detect if the raw content is likely a CSV (returns true) or XLSX (false).
 */
export function looksLikeCSV(content: Uint8Array): boolean {
  if (content.length < 4) return true  // too short to be XLSX/XLS
  // XLSX files start with PK\x03\x04 (ZIP magic bytes)
  if (content[0] === 0x50 && content[1] === 0x4b) return false
  // XLS files start with D0 CF 11 E0
  if (content[0] === 0xd0 && content[1] === 0xcf) return false
  return true
}

/**
 * Decode a Uint8Array as UTF-8 text, stripping BOM if present.
 */
export function decodeText(bytes: Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  return decoder.decode(bytes).replace(/^\uFEFF/, '')
}
