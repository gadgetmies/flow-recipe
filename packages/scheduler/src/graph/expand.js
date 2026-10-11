// Phase A expansion (spec §5.1 step 2): rules keyed by the catalogue operation's `expand` name, applied to fixpoint
// on RecipeModel tasks before instantiation. Ports the v1 `expand` functions of client/src/operations.js.

import { toBase } from '../units.js'

const MAX_ROUNDS = 32

function celsiusString(task) {
  const t = task.options?.temperature
  return t && t.number != null ? `${Math.round(Number(t.number))}` : null
}

function inputName(ref, recipe, tasks) {
  const ing = recipe?.ingredients?.find((i) => i.id === ref)
  if (ing) return ing.name
  for (const t of tasks) for (const o of t.outputs ?? []) if (o.id === ref) return o.name ?? o.id
  return ref
}

/** Locate the output (and its producing task) that `ref` resolves to, or null for ingredients/tools. */
export function findProducer(ref, tasks) {
  for (const t of tasks) for (const o of t.outputs ?? []) if (o.id === ref) return { task: t, output: o }
  return null
}

/**
 * bake-in-oven → preheat-oven (`${id}.preheat`), put-into-oven (`${id}.in`), take-out-of-oven (`${id}.out`).
 * The put-into-oven task carries the duration (passive bake) and the original tools as reserved carriers; the
 * take-out task carries the original outputs, hold and returned tools.
 */
function expandBakeInOven(task, { recipe, tasks }) {
  const celsius = celsiusString(task)
  const temperature = task.options?.temperature ?? null
  const duration = task.options?.duration ?? null
  const first = task.inputs?.[0]
  const name = first ? inputName(first.ref, recipe, tasks) : 'food'
  const ovenId = `${task.id}.oven`
  const bakingId = `${task.id}.baking`
  const outputs = (task.outputs ?? []).length > 0
    ? task.outputs
    : [{ id: `${task.id}.baked`, name: `baked ${name}`, amount: null, unit: null, hold: null, volume: null, final: false }]
  const primary = outputs[0]
  const preheat = {
    id: `${task.id}.preheat`,
    operation: 'preheat-oven',
    options: temperature ? { temperature } : {},
    inputs: [],
    tools: [],
    outputs: [{ id: ovenId, name: celsius ? `oven at ${celsius} °C` : 'hot oven', amount: null, unit: null, hold: 1200, volume: null, final: false }], // a hot oven waits at most 20 min: anchors the preheat
    returnsTools: [],
    instructions: null,
    requires: [],
  }
  const put = {
    id: `${task.id}.in`,
    operation: 'put-into-oven',
    options: { ...(duration ? { duration } : {}), ...(temperature ? { temperature } : {}) },
    inputs: [...(task.inputs ?? []), { ref: ovenId, amount: null, text: null }],
    tools: (task.tools ?? []).map((t) => ({ ...t, reserved: true })),
    outputs: [{ id: bakingId, name: `baking ${name}`, amount: primary.amount ?? null, unit: primary.unit ?? null, hold: null, volume: primary.volume ?? null, final: false }],
    returnsTools: [],
    instructions: task.instructions ?? null,
    requires: task.requires ?? [],
  }
  const out = {
    id: `${task.id}.out`,
    operation: 'take-out-of-oven',
    options: temperature ? { temperature } : {},
    inputs: [{ ref: bakingId, amount: null, text: null }],
    tools: task.tools ?? [],
    outputs,
    returnsTools: task.returnsTools ?? [],
    instructions: null,
    requires: task.requires ?? [],
  }
  return [preheat, put, out]
}

/**
 * split: keeps the task but fixes the primary output amount: `parts` option → parts; `unit-size` option →
 * floor(input mass / unit size), the mass taken from the producing output's amount (mass or volume, 1 ml ≈ 1 g).
 * Returns null when the amount is already right (fixpoint).
 */
function expandSplit(task, { tasks }) {
  const output = task.outputs?.[0]
  if (!output) return null
  let amount = null
  const parts = task.options?.parts
  const unitSize = task.options?.['unit-size']
  if (parts && parts.number != null) amount = Number(parts.number)
  else if (unitSize && unitSize.number != null) {
    const size = toBase({ number: unitSize.number, unit: unitSize.unit || 'g' })
    const producer = task.inputs?.[0] ? findProducer(task.inputs[0].ref, tasks) : null
    const src = producer?.output?.amount != null && producer.output.unit ? toBase({ number: producer.output.amount, unit: producer.output.unit }) : null
    if (size && size.number > 0 && src) amount = Math.floor(src.number / size.number + 1e-9)
  }
  if (amount == null || output.amount === amount) return null
  return [{ ...task, outputs: [{ ...output, amount }, ...task.outputs.slice(1)] }]
}

/** Expansion rules by catalogue `expand` name. A rule returns the replacement tasks or null for "no change". */
export const rules = {
  'bake-in-oven': expandBakeInOven,
  split: expandSplit,
}

/**
 * Apply the catalogue's expansion rules to fixpoint.
 * @param {Array} tasks RecipeModel tasks
 * @param {object} catalogue Catalogue
 * @param {object} [recipe] RecipeModel (for ingredient names)
 * @returns {Array} expanded tasks (new array; input not mutated)
 */
export function expandTasks(tasks, catalogue, recipe = null) {
  let current = tasks.slice()
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = false
    const next = []
    for (const task of current) {
      const op = catalogue?.[task.operation]
      const rule = op?.expand ? rules[op.expand] : null
      const result = rule ? rule(task, { recipe, tasks: current, catalogue }) : null
      if (result) {
        changed = true
        next.push(...result)
      } else next.push(task)
    }
    current = next
    if (!changed) return current
  }
  throw new Error(`Task expansion did not reach a fixpoint after ${MAX_ROUNDS} rounds`)
}
