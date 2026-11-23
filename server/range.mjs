// HTTP Range parsing (RFC 9110, single byte range).

export const UNSATISFIABLE = 'unsatisfiable'

/**
 * Parse a Range header for a resource of `size` bytes.
 *
 * @returns {null | {start: number, end: number} | 'unsatisfiable'}
 *   null: no usable range, serve the whole resource with 200. That covers a missing
 *         header, other units, malformed specs and multiple ranges (a server may
 *         ignore Range; players only ever ask for one).
 *   {start, end}: one satisfiable range, `end` inclusive, serve 206.
 *   'unsatisfiable': serve 416 with "Content-Range: bytes * /size".
 */
export function parseRange (header, size) {
  if (typeof header !== 'string' || header.length > 200) return null
  const m = /^\s*bytes\s*=\s*(.*?)\s*$/i.exec(header)
  if (m === null) return null
  const spec = m[1]
  if (spec.includes(',')) return null
  const r = /^(\d*)\s*-\s*(\d*)$/.exec(spec)
  if (r === null) return null
  const first = r[1]
  const last = r[2]
  if (first === '' && last === '') return null

  if (first === '') {
    // Suffix range: the last N bytes.
    const n = Number(last)
    if (n === 0 || size === 0) return UNSATISFIABLE
    return { start: Math.max(0, size - n), end: size - 1 }
  }

  const start = Number(first)
  if (last !== '' && Number(last) < start) return null // invalid spec: ignore the header
  if (start >= size) return UNSATISFIABLE
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  return { start, end }
}
