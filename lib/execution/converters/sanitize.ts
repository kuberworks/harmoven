// lib/execution/converters/sanitize.ts

/**
 * S2 — CSV formula injection guard.
 * Cells starting with = + - @ are prefixed with a single quote.
 * Standard anti-injection technique (Excel / LibreOffice).
 */
export function sanitizeCsvCell(cell: string): string {
  return /^[=+\-@]/.test(cell) ? `'${cell}` : cell
}

export function sanitizeCsvFormulas(csv: string): string {
  return csv
    .split('\n')
    .map(row =>
      row
        .split(',')
        .map(cell => sanitizeCsvCell(cell.trim()))
        .join(',')
    )
    .join('\n')
}

/**
 * S4 — Filename injection guard.
 * Strips CRLF and forbidden chars. Used to build the filename stored in DB.
 * The HTTP header uses encodeURIComponent() in addition (see S1 above).
 */
export function buildFilename(slug: string, ext: string): string {
  const safe = slug
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9\u00e0-\u024f]+/gi, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 48) || 'output'
  return `${safe}.${ext}`.replace(/[\r\n"\\]/g, '_')
}
