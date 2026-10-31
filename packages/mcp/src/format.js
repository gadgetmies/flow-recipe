// Helpers for shaping tool results: JSON text content, trimming, errors, amount parsing.

export const DEFAULT_MAX_STRING = 4000
export const DEFAULT_MAX_ARRAY = 80

/** An MCP tool result carrying pretty JSON. */
export function jsonResult(value, { isError = false } = {}) {
  const result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
  if (isError) result.isError = true
  return result
}

/** An MCP tool result carrying plain text (markdown). */
export function textResult(text, { isError = false } = {}) {
  const result = { content: [{ type: 'text', text: String(text) }] }
  if (isError) result.isError = true
  return result
}

/** A failed tool call: `error` is what went wrong, `hint` what to do about it, `details` anything structured. */
export function errorResult(error, { hint = null, ...details } = {}) {
  const value = { error: error instanceof Error ? error.message : String(error) }
  if (hint) value.hint = hint
  Object.assign(value, details)
  return jsonResult(value, { isError: true })
}

/**
 * Deep copy with long strings and arrays shortened. Keys listed in `keep` are copied untouched (e.g. `xml`, which
 * the agent needs in full).
 */
export function trimDeep(value, { maxString = DEFAULT_MAX_STRING, maxArray = DEFAULT_MAX_ARRAY, keep = [] } = {}, depth = 0) {
  if (typeof value === 'string') {
    return value.length > maxString ? `${value.slice(0, maxString)}… [${value.length - maxString} more characters]` : value
  }
  if (value === null || typeof value !== 'object') return value
  if (depth > 12) return '[nested too deep]'
  const options = { maxString, maxArray, keep }
  if (Array.isArray(value)) {
    const out = value.slice(0, maxArray).map(item => trimDeep(item, options, depth + 1))
    if (value.length > maxArray) out.push(`… ${value.length - maxArray} more items`)
    return out
  }
  if (typeof value.toJSON === 'function') return value.toJSON()
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'function' || item === undefined) continue
    out[key] = keep.includes(key) ? item : trimDeep(item, options, depth + 1)
  }
  return out
}

const VULGAR = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 }

/**
 * Parses recipe amounts: 2, "1.5", "1,5", "1 1/2", "1½", "3/4", "2-3" (→ midpoint). Returns null when unparseable.
 */
export function parseAmount(amount) {
  if (typeof amount === 'number') return Number.isFinite(amount) ? amount : null
  if (typeof amount !== 'string') return null
  let s = amount.trim().replace(/[¼½¾⅓⅔⅛⅜⅝⅞]/g, m => ` ${VULGAR[m]}`).replace(/⁄/g, '/').trim()
  const range = s.match(/^(.+?)\s*(?:-|–|to)\s*(.+)$/)
  if (range) {
    const a = parseAmount(range[1])
    const b = parseAmount(range[2])
    return a !== null && b !== null ? (a + b) / 2 : null
  }
  s = s.replace(/(\d),(\d)/g, '$1.$2')
  let total = 0
  let any = false
  for (const part of s.split(/\s+/).filter(Boolean)) {
    let n
    const fraction = part.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/)
    if (fraction) n = Number(fraction[1]) / Number(fraction[2])
    else n = Number(part)
    if (!Number.isFinite(n)) return null
    total += n
    any = true
  }
  return any ? total : null
}

/** "1 h 25 min" for a number of seconds. */
export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
  const minutes = Math.round(seconds / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** Valid recipe id: lowercase kebab-case, no path characters. */
export function isValidRecipeId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(id)
}

/** Any id the flow-recipe server accepts (letters, digits, - and _; max 100) — for reading existing recipes. */
export function isServerRecipeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)
}

/** Reads `<recipe id="…">` / `<recipe title="…">` / `<title>` without a full parse (best effort). */
export function sniffRecipeAttributes(xml) {
  const open = String(xml).match(/<recipe\b[^>]*>/)
  const attrs = {}
  if (open) {
    for (const m of open[0].matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[m[1]] = m[3] ?? m[4]
  }
  if (!attrs.title) {
    const t = String(xml).match(/<title>([^<]*)<\/title>/)
    if (t) attrs.title = t[1].trim()
  }
  return attrs
}

export function kebab(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
}
