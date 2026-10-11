// RecipeModel validation (README §2): references, ids, operations and options against the catalogue, units and
// unit streams. Errors make the recipe unusable; warnings are worth a look but the recipe still schedules.

import { isCount, isMass, isTime, isVolume, canonicalUnit } from '../units.js'

/** Every leaf task in document order: plain tasks and the steps of joins (not the join wrapper itself). */
function leafTasks(model) {
  const out = []
  for (const task of model.tasks) {
    if (task.operation === 'join' && Array.isArray(task.steps)) out.push(...task.steps)
    else out.push(task)
  }
  return out
}

/**
 * Check ids and references of a RecipeModel without a catalogue.
 *
 * Errors: duplicate ids across ingredients, tools, outputs and tasks; input refs that do not resolve to an
 * ingredient, a tool or an output produced earlier; tool refs (incl. returned tools) that do not resolve to a
 * declared tool; instruction refs that do not resolve; no final output.
 * Warnings: outputs with a `unit` consumed by a task whose outputs name a different unit.
 *
 * @param {object} model RecipeModel
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkReferences(model) {
  const errors = []
  const warnings = []
  const seen = new Map()
  const claim = (id, kind) => {
    if (seen.has(id)) errors.push(`Duplicate id '${id}': ${kind} and ${seen.get(id)}`)
    else seen.set(id, kind)
  }

  const ingredientIds = new Set()
  const toolIds = new Set()
  for (const ingredient of model.ingredients || []) {
    claim(ingredient.id, 'ingredient')
    ingredientIds.add(ingredient.id)
  }
  for (const tool of model.tools || []) {
    claim(tool.id, 'tool')
    toolIds.add(tool.id)
  }
  for (const task of model.tasks || []) {
    claim(task.id, `task '${task.id}'`)
    if (task.operation === 'join') for (const step of task.steps || []) claim(step.id, `task '${step.id}'`)
  }

  const tasks = leafTasks(model)
  const allOutputs = new Map()
  for (const task of tasks) {
    for (const output of task.outputs) {
      claim(output.id, `output of task '${task.id}'`)
      allOutputs.set(output.id, { task, output })
    }
  }

  const produced = new Map() // output id → task
  const consumedBy = new Map() // output id → [task]
  for (const task of tasks) {
    const where = `Task '${task.id}' (${task.operation})`
    for (const input of task.inputs) {
      if (ingredientIds.has(input.ref) || toolIds.has(input.ref)) continue
      if (produced.has(input.ref)) {
        if (!consumedBy.has(input.ref)) consumedBy.set(input.ref, [])
        consumedBy.get(input.ref).push(task)
        continue
      }
      if (allOutputs.has(input.ref)) {
        const producer = allOutputs.get(input.ref).task
        if (producer === task) errors.push(`${where} consumes its own output '${input.ref}'`)
        else errors.push(`${where} consumes '${input.ref}' before task '${producer.id}' produces it`)
      } else {
        errors.push(`${where} references unknown input '${input.ref}'`)
      }
    }
    for (const tool of task.tools) {
      if (!toolIds.has(tool.ref)) errors.push(`${where} references unknown tool '${tool.ref}'`)
    }
    for (const tool of task.returnsTools) {
      if (!toolIds.has(tool.ref)) errors.push(`${where} returns unknown tool '${tool.ref}'`)
    }
    if (Array.isArray(task.instructions)) {
      for (const item of task.instructions) {
        if (item.output !== undefined && !task.outputs.some((o) => o.id === item.output)) {
          errors.push(`${where} instructions mention output '${item.output}' the task does not produce`)
        }
        if (item.option !== undefined && !(item.option in task.options)) {
          errors.push(`${where} instructions mention option '${item.option}' the task does not have`)
        }
      }
    }
    for (const output of task.outputs) produced.set(output.id, task)
  }

  // Final outputs: explicit, or inferred as unconsumed.
  const finals = tasks.flatMap((t) => t.outputs.filter((o) => o.final || !consumedBy.has(o.id)))
  if (tasks.length > 0 && finals.length === 0) errors.push('No final output: every output is consumed by a later task')

  // Unit streams: an output with a unit consumed by a task whose own outputs are in a different unit.
  for (const task of tasks) {
    const own = task.outputs.map((o) => o.unit).filter((u) => u !== null && u !== undefined)
    if (own.length === 0) continue
    for (const input of task.inputs) {
      const entry = allOutputs.get(input.ref)
      if (!entry || entry.output.unit === null || entry.output.unit === undefined) continue
      if (!own.includes(entry.output.unit)) {
        warnings.push(
          `Task '${task.id}' consumes '${input.ref}' in unit '${entry.output.unit}' but produces unit(s) ${own.map((u) => `'${u}'`).join(', ')}`
        )
      }
    }
  }

  return { errors, warnings }
}

function isTemperatureUnit(unit) {
  const c = canonicalUnit(unit)
  return c === 'celsius' || c === 'fahrenheit'
}

function unitRecognised(name, unit) {
  if (name === 'duration') return isTime(unit)
  if (name === 'temperature') return isTemperatureUnit(unit)
  if (name === 'amount') return isMass(unit) || isVolume(unit) || isCount(unit)
  return true
}

/** Catalogue checks for one leaf task. */
function checkTask(task, catalogue, errors, warnings) {
  const where = `Task '${task.id}'`
  const operation = catalogue[task.operation]
  if (!operation) {
    errors.push(`${where} uses unknown operation '${task.operation}'`)
    return
  }
  const specs = operation.options || {}
  for (const [name, spec] of Object.entries(specs)) {
    if (spec && spec.required && !(name in task.options)) {
      errors.push(`${where} (${task.operation}) is missing required option '${name}'`)
    }
  }
  for (const [name, value] of Object.entries(task.options)) {
    const spec = specs[name]
    if (!spec) {
      warnings.push(`${where} (${task.operation}) has option '${name}' the catalogue does not list`)
    } else {
      const type = spec.type || 'numeric'
      const numeric = value.number !== undefined && value.number !== null
      if (type === 'numeric' && !numeric) errors.push(`${where} (${task.operation}): option '${name}' must be numeric`)
      if (type === 'text' && numeric) errors.push(`${where} (${task.operation}): option '${name}' must be text`)
    }
    const numeric = value.number !== undefined && value.number !== null
    if (numeric && Number.isNaN(Number(value.number))) {
      errors.push(`${where} (${task.operation}): option '${name}' is not a number`)
    }
    if (!numeric) continue
    if (value.unit !== undefined && value.unit !== null && value.unit !== '') {
      if (!unitRecognised(name, value.unit)) {
        warnings.push(`${where} (${task.operation}): option '${name}' has unrecognised unit '${value.unit}'`)
      }
    } else if ((name === 'duration' || name === 'temperature') && !(spec && spec.defaultUnit)) {
      warnings.push(`${where} (${task.operation}): option '${name}' has no unit and the catalogue has no default`)
    }
  }

  const min = (v) => (v === undefined || v === null ? 0 : v)
  const max = (v) => (v === undefined || v === null ? Infinity : v)
  const inputs = task.inputs.length
  const outputs = task.outputs.length
  if (inputs < min(operation.minInputs) || inputs > max(operation.maxInputs)) {
    warnings.push(`${where} (${task.operation}) has ${inputs} input(s); the catalogue expects ${arity(operation.minInputs, operation.maxInputs)}`)
  }
  if (outputs < min(operation.minOutputs) || outputs > max(operation.maxOutputs)) {
    warnings.push(`${where} (${task.operation}) has ${outputs} output(s); the catalogue expects ${arity(operation.minOutputs, operation.maxOutputs)}`)
  }
  if (operation.requiresTools && task.tools.length === 0) {
    warnings.push(`${where} (${task.operation}) names no tool but the operation requires one`)
  }
}

function arity(min, max) {
  const lo = min === undefined || min === null ? 0 : min
  if (max === undefined || max === null) return `at least ${lo}`
  if (lo === max) return `exactly ${lo}`
  return `${lo} to ${max}`
}

/**
 * Validate a RecipeModel against the operation catalogue (README §2 and §3).
 *
 * @param {object} model RecipeModel from parseRecipe
 * @param {object} [catalogue] Catalogue `{ [operationName]: Operation }`; when omitted only references are checked
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateRecipe(model, catalogue) {
  const { errors, warnings } = checkReferences(model)
  for (const tool of model.tools || []) {
    if (tool.capacity && tool.capacity.unit !== null && tool.capacity.unit !== undefined) {
      const u = tool.capacity.unit
      if (!(isVolume(u) || isMass(u) || isCount(u) || /^[a-z][a-z0-9-]*$/i.test(u))) {
        warnings.push(`Tool '${tool.id}' has capacity in unrecognised unit '${u}'`)
      }
    }
  }
  if (model.serving && !['hot', 'cold', 'ambient'].includes(model.serving.temperature)) {
    errors.push(`Serving temperature '${model.serving.temperature}' is not hot, cold or ambient`)
  }
  for (const task of leafTasks(model)) {
    for (const tool of task.tools) {
      if (tool.soil !== null && tool.soil !== undefined && !['none', 'rinse', 'wash'].includes(tool.soil)) {
        errors.push(`Task '${task.id}': tool '${tool.ref}' has soil '${tool.soil}', expected none, rinse or wash`)
      }
    }
    if (catalogue) checkTask(task, catalogue, errors, warnings)
  }
  return { valid: errors.length === 0, errors, warnings }
}
