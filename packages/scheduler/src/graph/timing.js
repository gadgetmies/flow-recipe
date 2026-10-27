// Duration model (README §3): active/passive seconds at speed 1 for one task given its unit count.
// This mirrors `catalogue/durations.js`; the two will be unified once both modules land.

import { toCelsius, toSeconds } from '../units.js'
import { amountSeconds } from '../catalogue/durations.js'

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)

/** Read a numeric option of a task in seconds, honouring the catalogue's default unit. */
export function optionSeconds(task, name, op) {
  const opt = task.options?.[name]
  if (!opt || opt.number == null) return 0
  const unit = opt.unit || op?.options?.[name]?.defaultUnit || 'seconds'
  try {
    return toSeconds({ number: opt.number, unit })
  } catch {
    return 0
  }
}

/** Read a temperature option of a task in °C; null when absent. */
export function optionCelsius(task, name = 'temperature', op) {
  const opt = task.options?.[name]
  if (!opt || opt.number == null) return null
  return toCelsius({ number: opt.number, unit: opt.unit || op?.options?.[name]?.defaultUnit || 'celsius' })
}

/**
 * Durations of one (non-join) task per README §3: time model applied to `units`, plus the passive part from
 * `passiveFrom` ('duration' option, 'formula:heat' = (°C − 10) × 5, 'formula:preheat' = (°C − 20) × 8).
 * @returns {{ active: number, passive: number, perUnit: number, timeModel: string }}
 */
export function computeDurations(op, task, units) {
  const time = op?.time ?? {}
  const timeModel = time.model ?? 'fixed'
  const fixed = num(time.active)
  const perUnit = amountSeconds(time, task) ?? num(time.perUnit)
  const n = Math.max(0, num(units))
  let active = fixed
  if (timeModel === 'per-unit') active = fixed + perUnit * n
  else if (timeModel === 'sub-linear') active = fixed + perUnit * Math.sqrt(n)
  let passive = num(time.passive)
  const from = time.passiveFrom ?? null
  if (from === 'duration') passive += optionSeconds(task, 'duration', op)
  else if (from === 'formula:heat' || from === 'formula:preheat') {
    const c = optionCelsius(task, 'temperature', op)
    if (c != null) passive += Math.max(0, from === 'formula:heat' ? (c - 10) * 5 : (c - 20) * 8)
  }
  return { active, passive, perUnit, timeModel }
}

/**
 * Durations of a task, handling `join` (sum of the steps, per-unit when any step is per-unit).
 * `resolveOp(task)` maps a task to its catalogue operation (with defaults applied).
 */
export function computeTaskDurations(task, resolveOp, units) {
  if (task.operation === 'join' && Array.isArray(task.steps) && task.steps.length > 0) {
    const parts = task.steps.map((s) => computeDurations(resolveOp(s), s, units))
    return {
      active: parts.reduce((a, p) => a + p.active, 0),
      passive: parts.reduce((a, p) => a + p.passive, 0),
      perUnit: parts.reduce((a, p) => a + (p.timeModel === 'per-unit' ? p.perUnit : 0), 0),
      timeModel: parts.some((p) => p.timeModel === 'per-unit') ? 'per-unit' : 'fixed',
    }
  }
  return computeDurations(resolveOp(task), task, units)
}
