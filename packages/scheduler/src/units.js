// Unit normalisation shared by the parser, the catalogue and the planner.

const MASS = { g: 1, gram: 1, grams: 1, kg: 1000, kilogram: 1000, kilograms: 1000, mg: 0.001, milligram: 0.001, milligrams: 0.001 }
const VOLUME = { ml: 1, milliliter: 1, milliliters: 1, millilitre: 1, millilitres: 1, cl: 10, dl: 100, deciliter: 100, deciliters: 100, l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000, tsp: 5, teaspoon: 5, teaspoons: 5, tbsp: 15, tablespoon: 15, tablespoons: 15, cup: 240, cups: 240 }
const COUNT = new Set(['pieces', 'piece', 'pcs', 'pc', 'units', 'unit', 'portion', 'portions', 'slices', 'slice', 'dash', 'dashes'])
const TIME = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hour: 3600, hours: 3600 }

const CANON_MASS = { mg: 'mg', g: 'g', kg: 'kg' }
const CANON_VOLUME = { ml: 'ml', cl: 'cl', dl: 'dl', l: 'l', tsp: 'tsp', tbsp: 'tbsp', cup: 'cup' }

function key(unit) {
  return String(unit || '').trim().toLowerCase()
}

export function isMass(unit) { return key(unit) in MASS }
export function isVolume(unit) { return key(unit) in VOLUME }
export function isCount(unit) { return COUNT.has(key(unit)) }
export function isTime(unit) { return key(unit) in TIME }

/** Canonical spelling of a unit; unknown units are returned trimmed and lower-cased. */
export function canonicalUnit(unit) {
  const k = key(unit)
  if (k in MASS) {
    if (MASS[k] === 1) return 'g'
    if (MASS[k] === 1000) return 'kg'
    return 'mg'
  }
  if (k in VOLUME) {
    const ml = VOLUME[k]
    const found = Object.entries(CANON_VOLUME).find(([c]) => VOLUME[c] === ml)
    return found ? found[1] : k
  }
  if (k in TIME) {
    if (TIME[k] === 1) return 'seconds'
    if (TIME[k] === 60) return 'minutes'
    return 'hours'
  }
  if (k === 'celcius' || k === 'celsius' || k === 'c' || k === '°c') return 'celsius'
  if (k === 'fahrenheit' || k === 'f' || k === '°f') return 'fahrenheit'
  if (k === 'percent' || k === '%') return 'percent'
  if (k === 'pcs' || k === 'pc' || k === 'piece') return 'pieces'
  return k
}

/** Normalise an amount to a canonical unit without changing its magnitude class (g stays g, l stays l). */
export function normaliseAmount({ number, unit }) {
  const n = Number(number)
  const k = key(unit)
  if (k in MASS) {
    const grams = n * MASS[k]
    return grams >= 1000 && Number.isInteger(grams / 1000) ? { number: grams / 1000, unit: 'kg' } : { number: grams, unit: 'g' }
  }
  if (k in VOLUME) {
    const c = canonicalUnit(k)
    return { number: n, unit: c }
  }
  return { number: n, unit: canonicalUnit(k) }
}

/** Convert a mass to grams or a volume to millilitres; returns null for other units. */
export function toBase({ number, unit }) {
  const k = key(unit)
  if (k in MASS) return { number: Number(number) * MASS[k], unit: 'g' }
  if (k in VOLUME) return { number: Number(number) * VOLUME[k], unit: 'ml' }
  return null
}

export function toSeconds({ number, unit }) {
  const k = key(unit)
  const f = TIME[k]
  if (f === undefined) throw new Error(`Unknown time unit '${unit}'`)
  return Number(number) * f
}

export function toCelsius({ number, unit }) {
  const k = key(unit)
  if (k === 'fahrenheit' || k === 'f' || k === '°f') return (Number(number) - 32) * 5 / 9
  return Number(number)
}

export { MASS, VOLUME, TIME, COUNT }
