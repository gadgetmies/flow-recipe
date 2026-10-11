// Duration model (README §3, spec §3.2): active and passive seconds of one task instance at speed 1.

import { toSeconds, toCelsius, isTime } from '../units.js'

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
export function activeSeconds(operation, units = 1) {
  const time = (operation && operation.time) || { model: 'fixed', active: 0, perUnit: 0 }
  const n = safeUnits(units)
  const active = Number(time.active) || 0
  const perUnit = Number(time.perUnit) || 0
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
  return { active: activeSeconds(op, units), passive: passiveSeconds(op, task) }
}
