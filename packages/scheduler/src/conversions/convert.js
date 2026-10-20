// Amount conversion to the metric kitchen policy (see the conversions section of the package README):
// weighable ingredients → g, thin liquids → ml/l, countables stay pieces, small amounts of spices / salt /
// leavening / extracts stay metric spoons unless the cook has a precision scale (then g with 0.1 g resolution).

import {
  BUTTER_STICK_GRAMS, COUNT, IMPERIAL_MASS, IMPERIAL_VOLUME, MASS, PINCH_GRAMS, VOLUME, imperialKey, isImperialLength, isLength,
} from '../units.js'
import { findDensity } from './match.js'
import { isSpoonIngredient } from './densities.js'

const TSP = 5
const TBSP = 15
/** Amounts at or below this volume (1 tbsp) or under SMALL_GRAMS stay spoons for spoon ingredients. */
const SMALL_ML = TBSP
const SMALL_GRAMS = 10

/** Extra count-like units that are kept as they are (pieces). */
const COUNTISH = new Set([
  'clove', 'cloves', 'sprig', 'sprigs', 'bunch', 'bunches', 'handful', 'handfuls', 'sheet', 'sheets', 'leaf', 'leaves',
  'can', 'cans', 'tin', 'tins', 'jar', 'jars', 'package', 'packages', 'packet', 'packets', 'envelope', 'envelopes',
  'bag', 'bags', 'head', 'heads', 'stalk', 'stalks', 'rib', 'ribs', 'drop', 'drops', 'pinch', 'pinches', 'dash',
  'dashes', 'cube', 'cubes', 'whole', 'each', 'ea', 'egg', 'eggs', 'drink', 'drinks', 'serving', 'servings',
])

/** Rounds a number to `step` without binary noise. */
function roundTo(n, step) {
  const r = Math.round(n / step) * step
  return Number(r.toFixed(6))
}

/** Tidy number for output: at most 3 decimals. */
export function tidy(n) {
  return Number(Number(n).toFixed(3))
}

/**
 * Kitchen rounding for grams: < 10 g → 1 g (0.1 g with a precision scale), < 250 g → 1 g, < 1000 g → 5 g,
 * otherwise 10 g. Idempotent: rounding a rounded value returns it unchanged. Under 1 g without a precision scale the step is 0.5 g; a positive amount never rounds to 0.
 */
export function roundForKitchen(grams, { precisionScale = false } = {}) {
  const g = Number(grams)
  if (!Number.isFinite(g) || g <= 0) return g
  let r
  if (g < 10) r = precisionScale ? roundTo(g, 0.1) : g < 1 ? roundTo(g, 0.5) : roundTo(g, 1)
  else if (g < 250) r = roundTo(g, 1)
  else if (g < 1000) r = roundTo(g, 5)
  else r = roundTo(g, 10)
  if (r === 0) r = precisionScale ? 0.1 : 0.5
  return r
}

/** Millilitres rounded for measuring jugs: < 15 ml → 1 ml, < 100 → 5 ml, < 1000 → 10 ml; ≥ 1 l → litres (0.05). */
function roundLiquid(ml) {
  if (ml >= 1000) return { number: roundTo(ml / 1000, 0.05), unit: 'l' }
  if (ml < 15) return { number: Math.max(roundTo(ml, 1), 1), unit: 'ml' }
  if (ml < 100) return { number: roundTo(ml, 5), unit: 'ml' }
  return { number: roundTo(ml, 10), unit: 'ml' }
}

/** Grams as g, or kg from 1000 g. */
function massAmount(grams, precisionScale) {
  const g = roundForKitchen(grams, { precisionScale })
  if (g >= 1000) return { number: tidy(g / 1000), unit: 'kg' }
  return { number: g, unit: 'g' }
}

/** Metric spoons: tbsp from 1 tbsp up (nearest 1/4), otherwise tsp to the nearest 1/4 (1/8 under 1/4 tsp). */
function spoonAmount(ml) {
  if (ml >= TBSP - 0.01) return { number: roundTo(ml / TBSP, 0.25), unit: 'tbsp' }
  const tsp = ml / TSP
  return { number: tsp < 0.25 ? Math.max(roundTo(tsp, 0.125), 0.125) : roundTo(tsp, 0.25), unit: 'tsp' }
}

/** Fahrenheit → Celsius rounded to the nearest 5 °C (350 °F → 175 °C). */
export function toCelsiusRounded(f) {
  return roundTo((Number(f) - 32) * 5 / 9, 5)
}

/** Inches → centimetres rounded to 0.5 cm (9 in → 23 cm). */
export function inchesToCm(n) {
  return roundTo(Number(n) * 2.54, 0.5)
}

function unitKey(unit) {
  if (unit === null || unit === undefined) return ''
  const raw = String(unit).trim()
  // US shorthand: capital T is a tablespoon, lower-case t a teaspoon.
  if (raw === 'T' || raw === 'Tbs' || raw === 'Tb') return 'tbsp'
  if (raw === 't') return 'tsp'
  const k = imperialKey(raw)
  if (k === 'tbs' || k === 'tbl' || k === 'tbsps' || k === 'tblsp' || k === 'tbls') return 'tbsp'
  if (k === 'tsps') return 'tsp'
  if (k === 'stick' || k === 'sticks') return 'stick'
  return k
}

function label(entry) {
  return entry ? entry.names[0] : null
}

/**
 * Converts one amount to the metric kitchen policy.
 *
 * @param {{ number: number, unit?: string|null }} amount
 * @param {{ ingredient?: string|null, properties?: object, precisionScale?: boolean, density?: object|null }} [options]
 *   density overrides the lookup by ingredient name (pass an entry from DENSITIES)
 * @returns {{ number, unit, from: { number, unit }, method: 'unchanged'|'metric'|'density'|'spoon'|'count',
 *   density: object|null, note: string|null }}
 */
export function toMetricAmount({ number, unit }, { ingredient = null, properties, precisionScale = false, density } = {}) {
  const n = Number(number)
  const from = { number: n, unit: unit === undefined ? null : unit }
  const entry = density !== undefined ? density : ingredient ? findDensity(ingredient, properties) : null
  const k = unitKey(unit)
  const result = (to, method, note = null) => ({ number: tidy(to.number), unit: to.unit, from, method, density: entry, note })
  const unchanged = (method = 'unchanged', note = null) => ({ number: n, unit: from.unit, from, method, density: entry, note })
  const entryNote = entry && entry.note ? `${label(entry)}: ${entry.note}` : null

  if (!Number.isFinite(n)) return unchanged('unchanged', 'not a number')

  // Pieces and other counts stay as they are; a stick of butter and, on a precision scale, a pinch are weighed.
  if (k === '' || COUNT.has(k) || COUNTISH.has(k)) {
    if ((k === 'pinch' || k === 'pinches') && precisionScale) {
      return result(massAmount(n * PINCH_GRAMS, true), 'metric', `a pinch ≈ ${PINCH_GRAMS} g`)
    }
    return unchanged('count')
  }
  if (k === 'stick') {
    if (entry && entry.kind === 'fat') {
      return result(massAmount(Math.round(n * BUTTER_STICK_GRAMS), precisionScale), 'metric', `one stick of ${label(entry)} = ${BUTTER_STICK_GRAMS} g`)
    }
    return unchanged('count')
  }

  // Mass.
  if (k in MASS) return unchanged('unchanged')
  if (k in IMPERIAL_MASS) {
    // "1 oz rum" in a drinks recipe means fluid ounces.
    if ((k === 'oz' || k === 'ounce' || k === 'ounces') && entry && entry.kind === 'liquid') {
      return volumeToMetric(n * IMPERIAL_VOLUME['fl oz'], { entry, precisionScale, imperial: true, result, unchanged, entryNote, ozAsFluid: true })
    }
    return result(massAmount(n * IMPERIAL_MASS[k], precisionScale), 'metric', entryNote)
  }

  // Volume.
  const metricVolume = k in VOLUME && k !== 'cup' && k !== 'cups'
  if (metricVolume || k in IMPERIAL_VOLUME) {
    const ml = n * (metricVolume ? VOLUME[k] : IMPERIAL_VOLUME[k])
    return volumeToMetric(ml, { entry, precisionScale, imperial: !metricVolume, result, unchanged, entryNote })
  }

  if (isImperialLength(k)) return result({ number: inchesToCm(n), unit: 'cm' }, 'metric')
  if (isLength(k)) return unchanged('unchanged')
  return unchanged('unchanged', `unknown unit '${unit}'`)
}

function volumeToMetric(ml, { entry, precisionScale, imperial, result, unchanged, entryNote, ozAsFluid = false }) {
  const fluid = ozAsFluid ? 'oz read as fluid ounces' : null
  const join = (...notes) => notes.filter(Boolean).join('; ') || null
  if (!entry) {
    if (!imperial) return unchanged('unchanged', 'no density known')
    return result(roundLiquid(ml), 'metric', join('no density known', fluid))
  }
  const grams = ml * entry.gPerMl
  if (entry.kind === 'liquid') {
    if (isSpoonIngredient(entry) && ml < SMALL_ML + 0.01) {
      if (precisionScale) return result(massAmount(grams, true), 'density', join(entryNote, fluid))
      if (!imperial) return unchanged('spoon')
      return result(spoonAmount(ml), 'spoon', join(entryNote, fluid))
    }
    if (!imperial) return unchanged('unchanged')
    return result(roundLiquid(ml), 'metric', join(entryNote, fluid))
  }
  if (isSpoonIngredient(entry) && !precisionScale && (ml <= SMALL_ML + 0.01 || grams < SMALL_GRAMS)) {
    if (!imperial) return unchanged('spoon')
    return result(spoonAmount(ml), 'spoon', entryNote)
  }
  return result(massAmount(grams, precisionScale), 'density', join(entryNote, fluid))
}

/** "1 cup", "0.25 tsp", "30 ml" — for comments and notes. */
export function formatAmount({ number, unit }) {
  return `${tidy(number)}${unit ? ` ${unit}` : ''}`
}
