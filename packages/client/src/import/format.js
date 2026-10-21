// Display helpers for the import review: amounts, converted-from chips, unit streams, plan summaries.

const FRACTIONS = [
  [0.25, '¼'],
  [0.333, '⅓'],
  [0.5, '½'],
  [0.667, '⅔'],
  [0.75, '¾'],
]

const UNIT_LABELS = {
  celsius: '°C',
  c: '°C',
  fahrenheit: '°F',
  f: '°F',
  grams: 'g',
  gram: 'g',
  kilograms: 'kg',
  liters: 'l',
  litres: 'l',
  milliliters: 'ml',
  millilitres: 'ml',
  deciliters: 'dl',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  pieces: 'pcs',
  piece: 'pcs',
  ounce: 'oz',
  ounces: 'oz',
  pound: 'lb',
  pounds: 'lb',
  lbs: 'lb',
  inch: 'in',
  inches: 'in',
  minutes: 'min',
  seconds: 's',
  hours: 'h',
}

const PIECE_UNITS = new Set(['pieces', 'piece', 'pcs', 'pc'])

const PLURAL_UNITS = new Set(['cup', 'stick', 'pint', 'quart', 'gallon', 'dash', 'pinch', 'clove', 'sheet', 'can'])

/** 285 → "285", 2.5 → "2.5", 0.333333 → "0.33" */
export function fmtNumber(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return ''
  const v = Number(n)
  return String(Math.round(v * 100) / 100)
}

/** Kitchen-style number for imperial amounts: 2.25 → "2¼", 0.5 → "½". */
export function fmtFraction(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  const whole = Math.floor(v)
  const rest = v - whole
  if (rest < 0.02) return String(whole)
  const f = FRACTIONS.find(([x]) => Math.abs(rest - x) < 0.02)
  if (!f) return fmtNumber(v)
  return whole > 0 ? `${whole}${f[1]}` : f[1]
}

export function unitLabel(unit, number = 1) {
  if (!unit) return ''
  const u = String(unit)
  const mapped = UNIT_LABELS[u.toLowerCase()]
  if (mapped) return mapped
  if (PLURAL_UNITS.has(u) && Number(number) > 1) return `${u}s`
  return u
}

/** { number: 250, unit: 'g' } → "250 g" */
export function fmtAmount(a, { fraction = false } = {}) {
  if (!a) return ''
  if (PIECE_UNITS.has(String(a.unit || '').toLowerCase())) return `× ${fmtNumber(a.number)}`
  const unit = unitLabel(a.unit, a.number)
  const num = fraction || unit === 'tsp' || unit === 'tbsp' ? fmtFraction(a.number) : fmtNumber(a.number)
  return unit ? `${num} ${unit}` : num
}

/** "from 2¼ cups" */
export function fromLabel(change) {
  return `from ${fmtAmount(change.from, { fraction: true })}`
}

/** Tooltip: "converted from 2.25 cup, all-purpose flour, 0.53 g/ml" */
export function conversionTooltip(change) {
  const parts = [`converted from ${fmtNumber(change.from?.number)} ${change.from?.unit || ''}`.trim()]
  if (change.note) parts.push(change.note)
  return parts.join(', ')
}

/** Simple English plural for unit-stream names: cookie → cookies, berry → berries. */
export function plural(word, n) {
  if (!word || n === 1) return word
  if (/s$/.test(word)) return word
  if (/[^aeiou]y$/.test(word)) return word.replace(/y$/, 'ies')
  if (/(ch|sh|x)$/.test(word)) return `${word}es`
  return `${word}s`
}

/** "× 24 cookies" for a task on a unit stream, else null. `unitStream` may be a name or `{ unit }`. */
export function streamLabel(task) {
  const stream = typeof task.unitStream === 'string' ? task.unitStream : task.unitStream?.unit || task.unitStream?.name || null
  const units = Number(task.units) || 0
  if (!stream || units < 2) return null
  return `× ${units} ${plural(stream, units)}`
}

/** Plan runs with different team sizes: `[{ participants, makespanSeconds }]`, accepting a few shapes. */
export function planRuns(plan) {
  if (!plan) return []
  if (Array.isArray(plan.runs)) return plan.runs.filter((r) => r && Number.isFinite(r.makespanSeconds))
  if (plan.byParticipants && typeof plan.byParticipants === 'object') {
    return Object.entries(plan.byParticipants)
      .map(([k, v]) => ({ participants: Number(k), makespanSeconds: v?.makespanSeconds ?? v }))
      .filter((r) => Number.isFinite(r.makespanSeconds))
  }
  if (Number.isFinite(plan.makespanSeconds)) return [{ participants: plan.participants || 1, makespanSeconds: plan.makespanSeconds }]
  return []
}

/** Names of a chain's stages, using the task titles from the summary. */
export function chainStageNames(chain, tasks = []) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  return (chain.stages || []).map((s) => {
    if (typeof s === 'string') return byId.get(s)?.title || byId.get(s)?.operation || s
    return s?.title || byId.get(s?.id || s?.taskId)?.title || s?.operation || s?.id || '?'
  })
}

/** The first conversion for a task (and ingredient), if any. */
export function conversionFor(conversions, taskId, ingredientId) {
  return (conversions || []).find((c) => c.taskId === taskId && (!ingredientId || !c.ingredientId || c.ingredientId === ingredientId)) || null
}

export function fmtHold(seconds) {
  if (!seconds) return null
  if (seconds >= 3600) return `${fmtNumber(seconds / 3600)} h`
  return `${Math.round(seconds / 60)} min`
}

/** Host name of a URL without "www.", or null. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch (e) {
    return null
  }
}

/**
 * A human line for an import job's `detail`, which the server passes through from the importer: a string (the URL),
 * a number, or an object such as `{ url }`, `{ text: true }`, `{ attempt }` or `{ attempts, ok }`. Null when there is
 * nothing worth showing. Never returns an object, so it is always safe to render.
 */
export function fmtJobDetail(detail) {
  if (detail === null || detail === undefined || detail === '') return null
  if (typeof detail === 'string') return /^https?:\/\//i.test(detail) ? `Reading ${hostOf(detail) || detail}` : detail
  if (typeof detail === 'number') return Number.isFinite(detail) ? String(detail) : null
  if (typeof detail !== 'object' || Array.isArray(detail)) return null
  if (typeof detail.message === 'string' && detail.message) return detail.message
  if (typeof detail.url === 'string' && detail.url) return `Reading ${hostOf(detail.url) || detail.url}`
  if (Number.isFinite(detail.attempt)) return detail.attempt > 1 ? `Attempt ${detail.attempt}` : null
  return null
}

/** Total time the source itself states, in seconds (`times.total`, else prep + cook), or null. */
export function sourceTotalSeconds(source) {
  const t = source?.times
  if (!t || typeof t !== 'object') return null
  if (Number.isFinite(t.total) && t.total > 0) return t.total
  const sum = (Number.isFinite(t.prep) ? t.prep : 0) + (Number.isFinite(t.cook) ? t.cook : 0)
  return sum > 0 ? sum : null
}

/** "1 h 30 min" / "45 min", rounded to whole minutes. */
export function fmtLongDuration(seconds) {
  if (!Number.isFinite(seconds)) return ''
  const m = Math.max(1, Math.round(seconds / 60))
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (!h) return `${m} min`
  return rest ? `${h} h ${rest} min` : `${h} h`
}

/** "about 1 h 10 min with 1 cook, 45 min with 3 cooks" from the plan runs. */
export function estimateSentence(runs) {
  if (!runs?.length) return null
  const parts = runs.map((r) => `${fmtLongDuration(r.makespanSeconds)} with ${r.participants} ${r.participants === 1 ? 'cook' : 'cooks'}`)
  return `About ${parts.join(', ')}`
}

/**
 * Plan diagnostics without the duplicates of the 1- and 3-cook runs: drops the "3 cooks: " prefix and a trailing
 * period before comparing, and turns "[CODE] message" into the message.
 */
export function dedupeDiagnostics(diagnostics) {
  const seen = new Set()
  const out = []
  for (const d of diagnostics || []) {
    let text = typeof d === 'string' ? d : d?.message || ''
    text = String(text)
      .replace(/^\d+ cooks?: /, '')
      .replace(/^\[[A-Z0-9_]+\]\s*/, '')
      .replace(/\.\s*$/, '')
      .trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(`${text}.`)
  }
  return out
}

/** Minutes until serving to suggest for a new session: the 1-cook estimate plus a little slack, rounded up to 5 min. */
export function suggestedServeInMinutes(plan) {
  const runs = planRuns(plan)
  if (!runs.length) return null
  const one = runs.find((r) => r.participants === 1) || runs[0]
  return Math.ceil((one.makespanSeconds / 60 + 10) / 5) * 5
}
