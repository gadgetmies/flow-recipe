// Duration model (README §3, spec §3.2): active and passive seconds of one task instance at speed 1.

import { toSeconds, toCelsius, isTime, isMass, isVolume, isCount, toBase, canonicalUnit, isImperialMass, isImperialVolume } from '../units.js'

const SPOON_UNITS = new Set(['tsp', 'tbsp', 'pinch', 'pinches', 'dash', 'dashes', 'drop', 'drops', 'sprig', 'sprigs', 'tl', 'rkl', 'msk', 'krm', 'el', 'ts', 'ss'])
const SPOON_MAX_ML = 15

/**
 * What measuring an amount takes (spec §3.2): `spoon` (a spoon or pinch of spice, up to 1 tbsp), `count` (eggs,
 * cloves: picking pieces), `weigh` (on a scale: tare and scoop), `pour` (a jug or cup of liquid), or null.
 */
export function amountKind(amount) {
  if (!amount || amount.unit === undefined || amount.unit === null || amount.unit === '') return amount && Number.isFinite(Number(amount.number)) ? 'count' : null
  const unit = String(amount.unit).trim()
  const lower = unit.toLowerCase()
  if (SPOON_UNITS.has(lower) || SPOON_UNITS.has(canonicalUnit(unit))) return 'spoon'
  if (isMass(unit)) return 'weigh'
  if (isVolume(unit)) {
    let ml = null
    try {
      ml = toBase({ number: Number(amount.number), unit }).number
    } catch {
      ml = null
    }
    return Number.isFinite(ml) && ml <= SPOON_MAX_ML ? 'spoon' : 'pour'
  }
  if (isImperialVolume(unit)) return 'pour'
  if (isImperialMass(unit)) return 'weigh'
  if (isCount(unit) || /^(pieces?|pcs?|cloves?|kpl|st|stk|sheets?|leaves|leaf|eggs?|slices?)$/i.test(unit)) return 'count'
  return null
}

/** Seconds per unit for a task from the operation's per-kind measuring times, or null to use `per-unit`. */
export function amountSeconds(time, task) {
  const by = time && time.byAmount
  if (!by) return null
  const amount = task && task.options ? task.options.amount : null
  const kind = amountKind(amount)
  return kind && Number.isFinite(by[kind]) ? by[kind] : null
}

function option(task, name) {
  const options = task && task.options
  const value = options ? options[name] : undefined
  return value && value.number !== undefined && value.number !== null ? value : null
}

function unitOf(value, operation, name, fallback) {
  if (value.unit) return value.unit
  const declared = operation && operation.options && operation.options[name]
  return (declared && declared.defaultUnit) || fallback
}

function durationOption(task, operation, name = 'duration') {
  const value = option(task, name)
  if (!value) return null
  const unit = unitOf(value, operation, name, 'seconds')
  if (!isTime(unit)) return null
  return Math.max(0, toSeconds({ number: value.number, unit }))
}

function temperatureOption(task, operation, name = 'temperature') {
  const value = option(task, name)
  if (!value) return null
  return toCelsius({ number: value.number, unit: unitOf(value, operation, name, 'celsius') })
}

function safeUnits(units) {
  const n = Number(units)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * Active (hands-on) seconds of a task for the given number of units, at speed 1.
 * `fixed` → active; `per-unit` → active + perUnit × units; `sub-linear` → active + perUnit × sqrt(units).
 *
 * @param {object} operation catalogue entry
 * @param {number} [units=1] n_j
 * @returns {number} seconds
 */
export function activeSeconds(operation, units = 1, task = null) {
  const time = (operation && operation.time) || { model: 'fixed', active: 0, perUnit: 0 }
  const n = safeUnits(units)
  const active = Number(time.active) || 0
  const perUnit = amountSeconds(time, task) ?? (Number(time.perUnit) || 0)
  switch (time.model) {
    case 'per-unit':
      return active + perUnit * n
    case 'sub-linear':
      return active + perUnit * Math.sqrt(n)
    default:
      return active
  }
}

/**
 * Passive (unattended) seconds that follow the active part. `passiveFrom` derives it from the task's options:
 * `duration` → the duration option in seconds; `formula:heat` → (°C − 10) × 5, or the duration option when no
 * temperature is given; `formula:preheat` → (°C − 20) × 8. Falls back to the constant `passive` part.
 *
 * @param {object} operation catalogue entry
 * @param {object} task RecipeModel Task (its `options` are read)
 * @returns {number} seconds
 */
export function passiveSeconds(operation, task) {
  const time = (operation && operation.time) || { passive: 0, passiveFrom: null }
  const constant = Math.max(0, Number(time.passive) || 0)
  switch (time.passiveFrom) {
    case 'duration': {
      const d = durationOption(task, operation)
      return d === null ? constant : d
    }
    case 'formula:heat': {
      const celsius = temperatureOption(task, operation)
      if (celsius !== null) return Math.max(0, (celsius - 10) * 5)
      const d = durationOption(task, operation)
      return d === null ? constant : d
    }
    case 'formula:preheat': {
      const celsius = temperatureOption(task, operation)
      return celsius === null ? constant : Math.max(0, (celsius - 20) * 8)
    }
    default:
      return constant
  }
}

/**
 * `{ active, passive }` seconds of a task instance at speed 1 (README §3).
 *
 * @param {object} operation catalogue entry (`catalogue[task.operation]`)
 * @param {object} task RecipeModel Task
 * @param {number} [units=1] number of units the instance handles (n_j)
 * @param {object} [catalogue] the catalogue, used to resolve `operation` when a name is passed
 * @returns {{ active: number, passive: number }}
 */
export function durations(operation, task, units = 1, catalogue) {
  const op = typeof operation === 'string' && catalogue ? catalogue[operation] : operation
  if (!op) return { active: 0, passive: 0 }
  return { active: activeSeconds(op, units, task), passive: passiveSeconds(op, task) }
}
