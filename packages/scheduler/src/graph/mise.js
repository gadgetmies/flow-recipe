// Ingredient handling (spec §3.10): storage freshness and mise en place gathering steps.
//
// Recipes state where an ingredient is kept (`<property name="storage" value="fridge|freezer"/>`) and, when it
// differs from the policy default, how long it may stay out (`<property name="out-of-storage">` with a duration).
// That is a fact about the food, so it lives in the recipe; the planner turns it into constraints:
//
// - A measuring step whose input is a fridge or freezer ingredient carries a freshness hold: the measured amount
//   must be used within the out-of-storage time, so the measuring is anchored close to its use instead of floating
//   to the start of the session.
// - With `policy.miseEnPlace`, gathering steps are added: one pantry step that fetches every shelf-stable ingredient
//   of every dish before anything is measured, and one step per dish and storage place (fridge, freezer) that takes
//   the perishables out just in time, with a freshness edge to every task that uses them.

import { toSeconds } from '../units.js'

export const DEFAULT_STORAGE_HOLD_SECONDS = Object.freeze({ fridge: 3600, freezer: 600 })
export const MEASURING_OPERATIONS = new Set(['measure', 'gather'])
export const MISE_CONTEXT_DISH = 'mise-en-place'

/** Where an ingredient is kept and how long it may stay out (seconds; Infinity for the pantry). */
export function ingredientStorage(ingredient, policy = {}) {
  const props = ingredient?.properties ?? {}
  const raw = String(props.storage?.value ?? props.storage?.text ?? 'pantry').trim().toLowerCase()
  if (raw !== 'fridge' && raw !== 'freezer') return { storage: 'pantry', hold: Infinity }
  let hold = policy?.storageHoldSeconds?.[raw] ?? DEFAULT_STORAGE_HOLD_SECONDS[raw]
  const out = props['out-of-storage']
  if (out && Number.isFinite(Number(out.number))) {
    try {
      hold = toSeconds({ number: Number(out.number), unit: out.unit || 'minutes' })
    } catch {
      // unknown unit: keep the default
    }
  }
  return { storage: raw, hold }
}

function names(list) {
  const uniq = [...new Set(list)]
  if (uniq.length <= 1) return uniq.join('')
  return `${uniq.slice(0, -1).join(', ')} and ${uniq[uniq.length - 1]}`
}

function minutes(seconds) {
  const m = Math.round(seconds / 60)
  return m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`
}

/**
 * Add freshness holds for perishable measuring and, with mise en place, the gathering steps.
 * Mutates the graph (tasks and edges); the caller recomputes the topological order afterwards.
 * @param {object} graph Graph under construction (README §5)
 * @param {object} session Session (dishes carry their RecipeModel)
 * @param {object} policy raw session policy (miseEnPlace, storageHoldSeconds)
 * @param {function} opFor (name) → operation with catalogue defaults
 */
export function applyIngredientHandling(graph, session, policy, opFor) {
  const dishes = (session.dishes ?? []).map((d) => ({ id: d.id ?? d.recipe?.id, recipe: d.recipe, title: d.recipe?.title ?? d.id }))
  const succ = new Map()
  for (const e of graph.edges) {
    if (!succ.has(e.from)) succ.set(e.from, [])
    succ.get(e.from).push(e)
  }
  const keys = new Map(graph.edges.map((e) => [`${e.from}|${e.to}|${e.kind}`, e]))
  const addEdge = (edge) => {
    const full = { lag: 0, ffLag: 0, hold: null, unitStream: null, ...edge }
    const key = `${full.from}|${full.to}|${full.kind}`
    const existing = keys.get(key)
    if (existing) {
      if (full.kind === 'maxlag') existing.hold = Math.min(existing.hold ?? Infinity, full.hold)
      return
    }
    keys.set(key, full)
    graph.edges.push(full)
  }
  const usersOf = (taskId) => (succ.get(taskId) ?? []).filter((e) => e.kind === 'fs' || e.kind === 'stream').map((e) => e.to)

  // every use of an ingredient by a task instance
  const uses = []
  for (const d of dishes) {
    const byId = new Map((d.recipe?.ingredients ?? []).map((i) => [i.id, i]))
    for (const t of Object.values(graph.tasks)) {
      if (t.dishId !== d.id || t.kind !== 'work') continue
      for (const inp of t.inputs ?? []) {
        const ing = byId.get(inp.ref)
        if (ing) uses.push({ dish: d, ingredient: ing, info: ingredientStorage(ing, policy), task: t })
      }
    }
  }

  // 1. perishable measuring is anchored by the out-of-storage time
  for (const u of uses) {
    if (!Number.isFinite(u.info.hold) || u.task.operation !== 'measure') continue
    u.task.hold = Math.min(u.task.hold ?? Infinity, u.info.hold)
    for (const to of usersOf(u.task.id)) addEdge({ from: u.task.id, to, kind: 'maxlag', hold: u.info.hold })
  }

  if (!policy?.miseEnPlace || uses.length === 0) return

  // 2. gathering steps
  const op = opFor('gather')
  const time = op.time ?? { active: 30, perUnit: 8 }
  const lead = policy?.gatherLeadSeconds ?? 900
  const make = ({ id, dishId, units, title, text, hold, station, releaseLead = null }) => {
    const active = (time.active ?? 30) + (time.perUnit ?? 8) * units
    graph.tasks[id] = {
      id,
      dishId,
      recipeTaskId: id,
      operation: 'gather',
      title,
      instructions: text,
      units,
      unitStream: null,
      batch: null,
      active,
      passive: 0,
      timeModel: 'fixed',
      perUnit: 0,
      attention: 'attended',
      checkInterval: null,
      checkDuration: null,
      divisible: 'none',
      minChunk: op.minChunk ?? 180,
      maxPeople: 1,
      speedup: 1,
      preemptible: op.preemptible ?? 'anywhere',
      resumeCost: op.resumeCost ?? 10,
      completion: null,
      context: { dish: dishId ?? MISE_CONTEXT_DISH, station: station ?? op.station ?? 'counter', tool: null },
      tedium: op.tedium ?? 0.8,
      requires: [],
      tools: [],
      appliance: null,
      returnsTools: [],
      hold,
      // taken out just in time: no earlier than this before its latest start (the hold still bounds the use)
      releaseLead,
      outputs: [],
      inputs: [],
      kind: 'work',
      serveWindow: null,
      gather: true,
    }
    return graph.tasks[id]
  }

  // 2a. one pantry step for every shelf-stable ingredient of every dish
  const pantry = uses.filter((u) => u.info.storage === 'pantry')
  if (pantry.length) {
    const perDish = dishes
      .map((d) => ({ d, list: [...new Set(pantry.filter((u) => u.dish.id === d.id).map((u) => u.ingredient.name || u.ingredient.id))] }))
      .filter((x) => x.list.length)
    const count = perDish.reduce((a, x) => a + x.list.length, 0)
    const text = `Gather from the pantry and set out on the counter: ${perDish.map((x) => `${names(x.list)} (${x.d.title})`).join('; ')}.`
    const g = make({ id: 'mise:gather-pantry', dishId: null, units: count, title: 'Gather pantry ingredients', text, hold: Infinity })
    for (const u of pantry) addEdge({ from: g.id, to: u.task.id, kind: 'fs' })
  }

  // 2b. per dish and storage place, taken out just in time. Items that keep only briefly (shorter than the
  // just-in-time lead, e.g. ice) get a step of their own each, right before their use; the rest go together.
  for (const d of dishes) {
    for (const storage of ['fridge', 'freezer']) {
      const group = uses.filter((u) => u.dish.id === d.id && u.info.storage === storage)
      if (!group.length) continue
      const shortLived = (u) => u.info.hold < lead
      const batches = []
      const long = group.filter((u) => !shortLived(u))
      if (long.length) batches.push({ suffix: '', uses: long })
      for (const id of [...new Set(group.filter(shortLived).map((u) => u.ingredient.id))]) {
        batches.push({ suffix: long.length || group.filter(shortLived).length > 1 ? `:${id}` : '', uses: group.filter((u) => u.ingredient.id === id) })
      }
      for (const b of batches) {
        const hold = Math.min(...b.uses.map((u) => u.info.hold))
        const list = [...new Set(b.uses.map((u) => u.ingredient.name || u.ingredient.id))]
        const text = `Take ${names(list)} for ${d.title} out of the ${storage}. Use within ${minutes(hold)}; put back what is left.`
        const g = make({ id: `mise:gather-${storage}:${d.id}${b.suffix}`, dishId: d.id, units: list.length, title: `Take out of the ${storage}`, text, hold, releaseLead: Math.min(lead, hold) })
        for (const u of b.uses) {
          addEdge({ from: g.id, to: u.task.id, kind: 'fs' })
          // out-of-storage time runs from taking it out until it is used: through a measuring step to its users;
          // each ingredient keeps its own limit (butter may stay out longer than milk)
          const targets = u.task.operation === 'measure' ? usersOf(u.task.id) : [u.task.id]
          for (const to of targets) addEdge({ from: g.id, to, kind: 'maxlag', hold: u.info.hold })
        }
      }
    }
  }
}
