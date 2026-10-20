// Unit policy checks on a parsed RecipeModel (README "Conversions").

import { canonicalUnit, isImperial, isMass, isVolume, toMetricBase } from '../units.js'
import { findDensity } from './match.js'
import { isSpoonIngredient } from './densities.js'
import { formatAmount, toMetricAmount } from './convert.js'

const SPOON_UNITS = new Set(['tsp', 'tbsp'])
const TWO_TBSP_ML = 30

function flatten(tasks) {
  const out = []
  for (const t of tasks || []) {
    if (t.steps) out.push(...flatten(t.steps))
    else out.push(t)
  }
  return out
}

/**
 * Flags amounts that break the metric unit policy.
 *
 * @param {object} model RecipeModel from parseRecipe
 * @param {{ precisionScale?: boolean }} [options]
 * @returns {{ level: 'warning'|'info', taskId: string|null, message: string }[]}
 */
export function lintRecipeUnits(model, { precisionScale = false } = {}) {
  const findings = []
  const push = (level, taskId, message) => findings.push({ level, taskId, message })
  const ingredients = new Map((model.ingredients || []).map((i) => [i.id, i]))
  const tasks = flatten(model.tasks)
  const outputNames = new Map()
  for (const t of tasks) for (const o of t.outputs || []) outputNames.set(o.id, o.name || o.id)

  for (const task of tasks) {
    const ref = (task.inputs || []).find((i) => ingredients.has(i.ref)) || (task.inputs || []).find((i) => outputNames.has(i.ref))
    const ingredient = ref ? ingredients.get(ref.ref) || { id: ref.ref, name: outputNames.get(ref.ref), properties: {} } : null

    for (const [name, value] of Object.entries(task.options || {})) {
      if (!value || value.number === undefined || value.number === null || !value.unit) continue
      const unit = value.unit
      const amount = formatAmount(value)
      if (isImperial(unit)) {
        const what = name === 'temperature' ? 'temperature' : `option '${name}'`
        push('warning', task.id, `${what} uses non-metric unit '${unit}' (${amount}); convert with metricizeRecipeXml`)
        continue
      }
      if (name !== 'amount' || !ingredient) continue
      const entry = findDensity(ingredient.name, ingredient.properties)
      const label = ingredient.name
      if (isVolume(unit)) {
        const ml = toMetricBase(value).number
        if (!entry) {
          push('info', task.id, `'${label}' is measured by volume (${amount}) and no density is known; check whether it should be weighed`)
          continue
        }
        if (entry.kind === 'liquid') {
          if (isSpoonIngredient(entry) && precisionScale && ml <= 15) {
            const r = toMetricAmount(value, { density: entry, precisionScale: true })
            push('info', task.id, `with a precision scale '${label}' can be weighed: ${amount} ≈ ${formatAmount(r)}`)
          }
          continue
        }
        const r = toMetricAmount(value, { density: entry, precisionScale })
        if (r.method === 'spoon') continue
        if (isSpoonIngredient(entry) && precisionScale && SPOON_UNITS.has(canonicalUnit(unit))) {
          push('info', task.id, `with a precision scale '${label}' can be weighed: ${amount} ≈ ${formatAmount(r)}`)
          continue
        }
        if (SPOON_UNITS.has(canonicalUnit(unit)) && ml > TWO_TBSP_ML) {
          push('warning', task.id, `${amount} of '${label}' is more than 2 tbsp of a weighable ingredient; weigh it (≈ ${formatAmount(r)})`)
          continue
        }
        if (SPOON_UNITS.has(canonicalUnit(unit))) {
          push('info', task.id, `${amount} of '${label}' could be weighed (≈ ${formatAmount(r)})`)
          continue
        }
        push('warning', task.id, `'${label}' (${entry.kind}) is measured by volume (${amount}); weigh it instead (≈ ${formatAmount(r)} at ${entry.gPerMl} g/ml)`)
      } else if (isMass(unit) && entry && entry.kind === 'liquid' && !isSpoonIngredient(entry)) {
        push('info', task.id, `'${label}' is a thin liquid measured by weight (${amount}); liquids are usually measured in ml`)
      }
    }
  }

  for (const tool of model.tools || []) {
    for (const [name, p] of Object.entries(tool.properties || {})) {
      if (p && p.unit && isImperial(p.unit)) push('warning', null, `Tool '${tool.id}' property '${name}' uses non-metric unit '${p.unit}'`)
      if (p && typeof p.value === 'string' && /\d\s*-?\s*(in|inch|inches|")\b/i.test(p.value)) push('warning', null, `Tool '${tool.id}' property '${name}' is in inches ('${p.value}')`)
    }
  }
  for (const ing of model.ingredients || []) {
    for (const [name, p] of Object.entries(ing.properties || {})) {
      if (p && p.unit && isImperial(p.unit)) push('warning', null, `Ingredient '${ing.id}' property '${name}' uses non-metric unit '${p.unit}'`)
    }
  }
  for (const task of tasks) {
    for (const o of task.outputs || []) {
      if (o.volume && o.volume.unit && isImperial(o.volume.unit)) push('warning', task.id, `Output '${o.id}' volume uses non-metric unit '${o.volume.unit}'`)
      if (o.unit && isImperial(o.unit)) push('warning', task.id, `Output '${o.id}' uses non-metric unit '${o.unit}'`)
    }
  }
  return findings
}
