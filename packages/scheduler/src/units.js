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

// ---------------------------------------------------------------------------------------------------------------
// Imperial / US customary units and lengths (additive: the tables above and the functions using them are unchanged,
// so `isMass('oz')` is still false and the parser keeps such units verbatim). Used by conversions/ to metricize.

/** Grams per imperial mass unit (avoirdupois). */
const IMPERIAL_MASS = { oz: 28.349523125, ounce: 28.349523125, ounces: 28.349523125, lb: 453.59237, lbs: 453.59237, pound: 453.59237, pounds: 453.59237 }
/** Millilitres per US customary volume unit. `cup` is the same 240 ml (US legal cup) as in VOLUME. */
const IMPERIAL_VOLUME = {
  'fl oz': 29.5735295625, floz: 29.5735295625, 'fluid ounce': 29.5735295625, 'fluid ounces': 29.5735295625,
  cup: 240, cups: 240,
  pint: 473.176473, pints: 473.176473, pt: 473.176473,
  quart: 946.352946, quarts: 946.352946, qt: 946.352946,
  gallon: 3785.411784, gallons: 3785.411784, gal: 3785.411784,
}
/** Centimetres per length unit. */
const LENGTH = {
  mm: 0.1, millimeter: 0.1, millimeters: 0.1, millimetre: 0.1, millimetres: 0.1,
  cm: 1, centimeter: 1, centimeters: 1, centimetre: 1, centimetres: 1,
  m: 100, meter: 100, meters: 100, metre: 100, metres: 100,
  in: 2.54, inch: 2.54, inches: 2.54, '"': 2.54,
}
const IMPERIAL_LENGTH = new Set(['in', 'inch', 'inches', '"'])
/** One US stick of butter (1/2 cup, 4 oz). */
const BUTTER_STICK_GRAMS = 113
/** A pinch when weighed (salt / ground spice). */
const PINCH_GRAMS = 0.3

/** Unit key tolerant of US spellings: 'Fl. Oz.' → 'fl oz', 'fl.oz' → 'fl oz', 'lbs.' → 'lbs'. */
export function imperialKey(unit) {
  return key(unit).replace(/\./g, ' ').replace(/\s+/g, ' ').trim().replace(/^fl ?oz$/, 'fl oz')
}

export function isImperialMass(unit) { return imperialKey(unit) in IMPERIAL_MASS }
export function isImperialVolume(unit) { return imperialKey(unit) in IMPERIAL_VOLUME }
export function isLength(unit) { return imperialKey(unit) in LENGTH }
export function isImperialLength(unit) { return IMPERIAL_LENGTH.has(imperialKey(unit)) }
export function isFahrenheit(unit) { return canonicalUnit(unit) === 'fahrenheit' }
/** True for any non-metric unit this module knows (US mass/volume incl. cup, inches, Fahrenheit). */
export function isImperial(unit) {
  return isImperialMass(unit) || isImperialVolume(unit) || isImperialLength(unit) || isFahrenheit(unit)
}

/** Mass → grams, volume → millilitres, length → centimetres, for metric and imperial units; null otherwise. */
export function toMetricBase({ number, unit }) {
  const n = Number(number)
  const k = key(unit)
  if (k in MASS) return { number: n * MASS[k], unit: 'g' }
  if (k in VOLUME) return { number: n * VOLUME[k], unit: 'ml' }
  const ik = imperialKey(unit)
  if (ik in IMPERIAL_MASS) return { number: n * IMPERIAL_MASS[ik], unit: 'g' }
  if (ik in IMPERIAL_VOLUME) return { number: n * IMPERIAL_VOLUME[ik], unit: 'ml' }
  if (ik in LENGTH) return { number: n * LENGTH[ik], unit: 'cm' }
  return null
}

/** Length in any known unit → centimetres; null for other units. */
export function toCentimeters({ number, unit }) {
  const ik = imperialKey(unit)
  return ik in LENGTH ? Number(number) * LENGTH[ik] : null
}

export { IMPERIAL_MASS, IMPERIAL_VOLUME, LENGTH, BUTTER_STICK_GRAMS, PINCH_GRAMS }
