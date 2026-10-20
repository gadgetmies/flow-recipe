// Phase B quantity propagation (spec §5.2 step 1), backward from each dish's final outputs with the scale applied.
//
// Decisions: an output with a count-like `unit` (not mass, volume, time or a generic count such as 'pieces') names a
// unit stream. A task whose primary output is on a stream carries `units` = the number of stream units demanded of
// it (64 buns); every other task carries `units` = its multiplier, i.e. how many recipe-scale runs are demanded
// (1 × scale for a measure task). Inputs with an explicit `amount` demand amount × multiplier of their producer,
// inputs without one consume all of the producer's declared output (× multiplier).

import { isCount, isMass, isTime, isVolume } from '../units.js'

/** The unit-stream name of an output, or null when its unit is a quantity unit (g, ml, pieces, …) or absent. */
export function streamUnit(output) {
  const u = output?.unit
  if (!u) return null
  if (isMass(u) || isVolume(u) || isTime(u) || isCount(u)) return null
  return String(u).trim().toLowerCase()
}

/** Topological order of tasks following input → producing output; throws with the cycle on a loop. */
export function orderTasks(tasks) {
  const producer = new Map()
  for (const t of tasks) for (const o of t.outputs ?? []) producer.set(o.id, t)
  const state = new Map()
  const order = []
  const stack = []
  const visit = (t) => {
    const s = state.get(t.id)
    if (s === 'done') return
    if (s === 'active') {
      const cycle = stack.slice(stack.indexOf(t.id)).concat(t.id)
      throw new Error(`Cycle in recipe tasks: ${cycle.join(' → ')}`)
    }
    state.set(t.id, 'active')
    stack.push(t.id)
    for (const input of t.inputs ?? []) {
      const p = producer.get(input.ref)
      if (p && p !== t) visit(p)
    }
    stack.pop()
    state.set(t.id, 'done')
    order.push(t)
  }
  for (const t of tasks) visit(t)
  return order
}

/**
 * Propagate quantities backward through a (expanded) recipe at `scale`.
 * @param {object} recipe RecipeModel whose `tasks` are already expanded
 * @param {number} scale dish scale
 * @returns {{ tasks: { [taskId]: { units, multiplier, unitStream, outputs: [{ id, amount, unit }], inputs: [{ ref, amount }] } },
 *   producers: { [outputId]: taskId }, finalOutputs: [outputId], order: [taskId] }}
 */
export function propagateQuantities(recipe, scale = 1) {
  const tasks = recipe.tasks ?? []
  const order = orderTasks(tasks)
  const producer = new Map()
  const outputOf = new Map()
  const consumers = new Map()
  for (const t of tasks) {
    for (const o of t.outputs ?? []) {
      producer.set(o.id, t)
      outputOf.set(o.id, o)
    }
  }
  for (const t of tasks) {
    for (const input of t.inputs ?? []) {
      if (!producer.has(input.ref)) continue
      if (!consumers.has(input.ref)) consumers.set(input.ref, [])
      consumers.get(input.ref).push(t)
    }
  }

  // Forward pass: declared amounts (per recipe scale 1). Stream outputs without an amount inherit the count of a
  // same-stream input.
  const declared = new Map()
  for (const t of order) {
    for (const o of t.outputs ?? []) {
      if (o.amount != null) {
        declared.set(o.id, Number(o.amount))
        continue
      }
      const stream = streamUnit(o)
      let inherited = null
      if (stream) {
        for (const input of t.inputs ?? []) {
          const src = outputOf.get(input.ref)
          if (src && streamUnit(src) === stream && declared.get(src.id) != null) {
            inherited = declared.get(src.id)
            break
          }
        }
      }
      declared.set(o.id, inherited)
    }
  }
  const declaredOf = (id) => declared.get(id) ?? 1

  // Final outputs: explicit `final` plus every output nobody consumes.
  const finalOutputs = []
  for (const t of tasks) for (const o of t.outputs ?? []) if (o.final || !consumers.has(o.id)) finalOutputs.push(o.id)

  // Backward pass.
  const demand = new Map()
  for (const id of finalOutputs) demand.set(id, (demand.get(id) ?? 0) + declaredOf(id) * scale)
  const result = {}
  for (const t of order.slice().reverse()) {
    const outputs = t.outputs ?? []
    const primary = outputs[0] ?? null
    let multiplier = scale
    if (primary) {
      if (!demand.has(primary.id)) demand.set(primary.id, declaredOf(primary.id) * scale)
      multiplier = demand.get(primary.id) / declaredOf(primary.id)
    }
    const unitStream = primary ? streamUnit(primary) : null
    const units = unitStream ? Math.ceil(demand.get(primary.id) - 1e-9) : multiplier
    const inputs = []
    for (const input of t.inputs ?? []) {
      const p = producer.get(input.ref)
      if (!p) {
        inputs.push({ ref: input.ref, amount: input.amount != null ? Number(input.amount) * multiplier : null })
        continue
      }
      const need = input.amount != null ? Number(input.amount) * multiplier : declaredOf(input.ref) * multiplier
      demand.set(input.ref, (demand.get(input.ref) ?? 0) + need)
      inputs.push({ ref: input.ref, amount: need })
    }
    result[t.id] = {
      units,
      multiplier,
      unitStream,
      outputs: outputs.map((o) => ({ id: o.id, amount: declaredOf(o.id) * multiplier, unit: o.unit ?? null })),
      inputs,
    }
  }
  return {
    tasks: result,
    producers: Object.fromEntries([...producer].map(([id, t]) => [id, t.id])),
    finalOutputs,
    order: order.map((t) => t.id),
  }
}
