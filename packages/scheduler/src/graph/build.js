// Phases A and B (spec §5.1, §5.2): Session + Catalogue → Graph (README §5).

import { defaultInventory, toolCapacity, toolCount } from '../inventory.js'
import { expandTasks } from './expand.js'
import { propagateQuantities, streamUnit } from './quantities.js'
import { computeTaskDurations, optionCelsius } from './timing.js'
import { renderInstructions } from './instructions.js'
import { applyIngredientHandling } from './mise.js'

const APPLIANCE_STATIONS = new Set(['oven', 'microwave'])
const HANDOFF_SECONDS = 10
const DEFAULT_POLICY = { hotHoldSeconds: 600, coldHoldSeconds: 1200 }
const DEFAULT_LATE_TOLERANCE_MS = 300_000

/** Catalogue defaults (README §3) applied over a possibly partial operation. */
export function operationWithDefaults(name, op) {
  const time = { model: 'fixed', active: 0, perUnit: 0, passive: 0, passiveFrom: null, ...(op?.time ?? {}) }
  const perUnit = time.model === 'per-unit'
  const passive = time.passive > 0 || time.passiveFrom != null
  return {
    name,
    title: name,
    minInputs: 0,
    maxInputs: null,
    minOutputs: 0,
    maxOutputs: null,
    requiresTools: false,
    options: {},
    attention: passive ? 'unattended' : 'attended',
    checkInterval: null,
    checkDuration: null,
    divisible: perUnit ? 'units' : 'none',
    minChunk: 180,
    maxPeople: 1,
    speedup: 1,
    preemptible: perUnit ? 'units' : 'never',
    resumeCost: 0,
    completion: { urgency: 'relaxed', early: 0, late: 0, duration: 30 },
    soil: 'rinse',
    station: 'counter',
    tedium: 1,
    requires: [],
    expand: null,
    ...(op ?? {}),
    time,
  }
}

function uniq(list) {
  return [...new Set(list)]
}

function pushDiagnostic(graph, seen, diag) {
  const key = `${diag.code}|${diag.dish ?? ''}|${diag.task ?? ''}|${diag.message}`
  if (seen.has(key)) return
  seen.add(key)
  graph.diagnostics.push(diag)
}

/** Hold of a finished dish from <serving> or the policy (spec §3.8). */
export function dishHold(serving, policy) {
  const p = { ...DEFAULT_POLICY, ...(policy ?? {}) }
  const temperature = serving?.temperature ?? 'ambient'
  if (serving?.hold != null && Number.isFinite(serving.hold)) return serving.hold
  if (temperature === 'hot') return p.hotHoldSeconds
  if (temperature === 'cold') return p.coldHoldSeconds
  return Infinity
}

/** Cumulative unit ranges of batch instances: [start, end) over the task's units. */
function batchRanges(units, cap, batches) {
  const ranges = []
  let start = 0
  for (let i = 0; i < batches; i++) {
    const n = batches === 1 ? units : Math.min(cap, units - start)
    ranges.push({ start, end: start + n, units: n })
    start += n
  }
  return ranges
}

function wirePairs(prod, cons) {
  const pairs = []
  const byRange = prod.instances.length > 1 && cons.instances.length > 1 && prod.units === cons.units
  for (const p of prod.instances) {
    for (const c of cons.instances) {
      if (byRange && !(p.range.start < c.range.end && c.range.start < p.range.end)) continue
      pairs.push([p, c])
    }
  }
  return pairs
}

function batchWord(record) {
  if (record.applianceBatched) return 'round'
  if (record.carrier) return record.carrier.type.split('-').pop()
  return 'batch'
}

function buildDish(dish, session, catalogue, inventory, policy, graph, seen) {
  const recipe = dish.recipe
  if (!recipe) throw new Error(`Dish '${dish.id}' has no recipe model`)
  const dishId = dish.id ?? recipe.id
  const scale = dish.scale ?? 1
  const tasks = expandTasks(recipe.tasks ?? [], catalogue, recipe)
  const q = propagateQuantities({ ...recipe, tasks }, scale)
  // the dish's own result: the outputs marked final, else every output nobody consumes
  const explicitFinal = tasks.flatMap((t) => (t.outputs ?? []).filter((o) => o.final).map((o) => o.id))
  const finalSet = new Set(explicitFinal.length > 0 ? explicitFinal : q.finalOutputs)
  const servingHold = dishHold(recipe.serving, policy)
  const resolveOp = (t) => {
    const op = catalogue?.[t.operation]
    if (!op && t.operation !== 'join') {
      pushDiagnostic(graph, seen, { code: 'UNKNOWN_OPERATION', message: `Operation '${t.operation}' is not in the catalogue; using defaults`, dish: dishId, task: t.id })
    }
    return operationWithDefaults(t.operation, op)
  }
  const counter = inventory.stations?.find((s) => s.type === 'counter') ?? null

  // --- pass 1: operation, quantities, durations, tools, appliance, own carrier ---
  const records = new Map()
  for (const task of tasks) {
    const op = task.operation === 'join' ? joinOperation(task, resolveOp) : resolveOp(task)
    const qi = q.tasks[task.id]
    const units = qi.units
    const unitStream = qi.unitStream
    const timing = computeTaskDurations(task, resolveOp, units)

    const tools = []
    const applianceRefs = []
    for (const t of task.tools ?? []) {
      const def = recipe.tools?.find((x) => x.id === t.ref) ?? null
      const type = def?.type ?? t.ref
      if (inventory.appliances?.some((a) => a.type === type)) {
        applianceRefs.push(type)
        continue
      }
      const inInventory = inventory.tools?.some((x) => x.type === type)
      if (!inInventory) {
        pushDiagnostic(graph, seen, { code: 'TOOL_NOT_IN_INVENTORY', message: `Tool type '${type}' is not in the inventory; assuming one instance`, dish: dishId, task: task.id })
      }
      tools.push({
        type,
        qty: t.qty ?? 1,
        mode: t.reserved ? 'reserved' : 'active',
        soil: t.soil ?? op.soil ?? 'rinse',
        capacity: pickCapacity(toolCapacity(inventory, type), def?.capacity),
        count: inInventory ? toolCount(inventory, type) : 1,
      })
    }
    const applianceType = APPLIANCE_STATIONS.has(op.station) ? op.station : applianceRefs[0] ?? null
    let appliance = null
    if (applianceType) {
      const inv = inventory.appliances?.find((a) => a.type === applianceType) ?? null
      if (!inv) pushDiagnostic(graph, seen, { code: 'TOOL_NOT_IN_INVENTORY', message: `Appliance '${applianceType}' is not in the inventory; assuming one slot`, dish: dishId, task: task.id })
      const celsius = inv?.modes === false ? null : optionCelsius(task, 'temperature', op)
      appliance = { type: applianceType, slots: inv?.slots ?? 1, mode: celsius != null ? `${Math.round(celsius)}c` : null }
    }

    // the task's own carrier: its smallest capacity tool in the stream's unit
    const ownCarrier = unitStream
      ? tools
          .filter((t) => t.capacity && String(t.capacity.unit).toLowerCase() === unitStream && t.capacity.number > 0)
          .map((t) => ({ type: t.type, cap: t.capacity.number, carriers: t.count }))
          .sort((a, b) => a.cap - b.cap)[0] ?? null
      : null
    const returnsTools = uniq((task.returnsTools ?? []).map((r) => recipe.tools?.find((x) => x.id === r.ref)?.type ?? r.ref))
    // a final output without a hold of its own inherits the dish's serving hold (spec §3.8): the recipe-level fact
    // "how long the dish stays good" bounds how early its last step may finish, so the producer is released just in time
    const holds = (task.outputs ?? [])
      .map((o) => (o.hold != null && Number.isFinite(o.hold) ? o.hold : finalSet.has(o.id) ? servingHold : null))
      .filter((h) => h != null && Number.isFinite(h))
    const hold = holds.length > 0 ? Math.min(...holds) : Infinity
    records.set(task.id, { task, op, units, unitStream, timing, tools, appliance, ownCarrier, carrier: null, applianceBatched: false, returnsTools, hold, instances: [], outputs: qi.outputs })
  }

  const outputs = new Map()
  for (const task of tasks) for (const o of task.outputs ?? []) outputs.set(o.id, { task, output: o })
  const isStreamLink = (prod, cons, output) =>
    prod.timing.timeModel === 'per-unit' && cons.timing.timeModel === 'per-unit' && cons.unitStream != null && streamUnit(output) === cons.unitStream

  // --- pass 2: carriers (spec §3.9). A task's carrier is its own capacity tool, else the carrier inherited along an
  // incoming stream edge (the buns stay on the sheet through brushing and sprinkling) unless the task returns it.
  const carrierOf = (taskId) => {
    const rec = records.get(taskId)
    if (rec.carrier !== null || rec.carrierResolved) return rec.carrier
    rec.carrierResolved = true
    let carrier = rec.ownCarrier
    if (!carrier) {
      for (const input of rec.task.inputs ?? []) {
        const src = outputs.get(input.ref)
        if (!src || src.task === rec.task) continue
        const prod = records.get(src.task.id)
        if (!isStreamLink(prod, rec, src.output)) continue
        const inherited = carrierOf(src.task.id)
        if (inherited && !rec.returnsTools.includes(inherited.type)) {
          carrier = inherited
          break
        }
      }
    }
    rec.carrier = carrier ?? null
    return rec.carrier
  }
  for (const task of tasks) carrierOf(task.id)

  // the batched producer whose carrier this task returns, when those carriers cannot hold all units at once
  const carrierReleaseSource = (task, record) => {
    for (const input of task.inputs ?? []) {
      const src = outputs.get(input.ref)
      if (!src || src.task === task) continue
      const prod = records.get(src.task.id)
      const c = prod.carrier
      if (!c || !record.returnsTools.includes(c.type) || prod.instances.length < 2 || prod.units !== record.units) continue
      if (Number.isFinite(c.carriers) && c.carriers * c.cap >= prod.units) continue
      return prod
    }
    return null
  }

  // --- pass 3: batch counts (spec §5.2 step 3) and instances ---
  for (const task of tasks) {
    const record = records.get(task.id)
    const { op, units, unitStream, timing, tools, appliance, carrier, returnsTools, hold } = record
    let cap = Infinity
    if (appliance) {
      if (carrier) {
        // a round holds at most as many carriers as the kitchen has (one pizza stone in a two-shelf oven: one per round)
        const carriersPerRound = Math.max(1, Math.min(appliance.slots, Number.isFinite(carrier.carriers) && carrier.carriers > 0 ? carrier.carriers : appliance.slots))
        cap = carriersPerRound * carrier.cap
        record.applianceBatched = true
      } else if (unitStream) {
        pushDiagnostic(graph, seen, { code: 'NO_CAPACITY', message: `Task '${task.id}' uses the ${appliance.type} on stream '${unitStream}' without a carrier capacity; cannot derive rounds`, dish: dishId, task: task.id })
      }
    } else if (carrier) cap = carrier.cap
    let batches = Number.isFinite(cap) && cap < units ? Math.ceil(units / cap) : 1
    let ranges = batchRanges(units, cap, batches)
    // the task that empties a carrier (lifts the pitas off the stone) works round by round when the kitchen does not
    // have enough carriers for all units at once: the carrier must come back before the next round can be loaded
    const release = batches === 1 ? carrierReleaseSource(task, record) : null
    if (release) {
      batches = release.instances.length
      ranges = release.instances.map((x) => x.range)
    }
    const qi = q.tasks[task.id]
    const baseText = renderInstructions(task, recipe, catalogue, tasks)
    const word = batchWord(record)

    for (let b = 0; b < batches; b++) {
      const range = ranges[b]
      const batchUnits = range.units
      const batchTiming = batches > 1 ? computeTaskDurations(task, resolveOp, batchUnits) : timing
      const id = batches > 1 ? `${dishId}:${task.id}#b${b + 1}` : `${dishId}:${task.id}`
      const batch = batches > 1 ? { index: b + 1, of: batches } : null
      const share = units > 0 ? batchUnits / units : 1
      const instance = {
        id,
        dishId,
        recipeTaskId: task.id,
        operation: task.operation,
        title: op.title,
        instructions: batch ? `${baseText} (${word} ${batch.index} of ${batch.of})` : baseText,
        units: batchUnits,
        unitStream,
        batch,
        active: batchTiming.active,
        passive: batchTiming.passive,
        timeModel: batchTiming.timeModel,
        perUnit: batchTiming.perUnit,
        attention: op.attention,
        checkInterval: op.checkInterval ?? null,
        checkDuration: op.checkDuration ?? null,
        divisible: op.divisible,
        minChunk: op.minChunk,
        maxPeople: op.maxPeople,
        speedup: op.speedup,
        preemptible: op.preemptible,
        resumeCost: op.resumeCost,
        completion: batchTiming.passive > 0 ? { ...op.completion } : null,
        context: { dish: dishId, station: op.station ?? 'counter', tool: tools[0]?.type ?? null },
        tedium: op.tedium ?? 1,
        requires: uniq([...(op.requires ?? []), ...(task.requires ?? [])]),
        tools: tools.map(({ type, qty, mode, soil }) => ({ type, qty, mode, soil })),
        appliance: appliance ? { ...appliance } : null,
        returnsTools,
        hold,
        outputs: qi.outputs.map((o) => ({ id: o.id, amount: o.amount != null ? o.amount * share : null, unit: o.unit })),
        inputs: qi.inputs.map((i) => ({ ref: i.ref, amount: i.amount != null ? i.amount * share : null })),
        kind: 'work',
        serveWindow: null,
      }
      graph.tasks[id] = instance
      record.instances.push({ instance, range })
    }
  }

  // --- edges (spec §5.1 step 5) ---
  const edgeKeys = new Set()
  const addEdge = (edge) => {
    const key = `${edge.from}|${edge.to}|${edge.kind}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    graph.edges.push(edge)
  }
  for (const task of tasks) {
    const cons = records.get(task.id)
    for (const input of task.inputs ?? []) {
      const src = outputs.get(input.ref)
      if (!src || src.task === task) continue
      const prod = records.get(src.task.id)
      const stream = isStreamLink(prod, cons, src.output)
      for (const [p, c] of wirePairs(prod, cons)) {
        if (stream) {
          addEdge({ from: p.instance.id, to: c.instance.id, kind: 'stream', lag: p.instance.perUnit + HANDOFF_SECONDS, ffLag: c.instance.perUnit, hold: null, unitStream: cons.unitStream })
        } else {
          addEdge({ from: p.instance.id, to: c.instance.id, kind: 'fs', lag: 0, ffLag: 0, hold: null, unitStream: null })
        }
        if (src.output.hold != null && Number.isFinite(src.output.hold)) {
          addEdge({ from: p.instance.id, to: c.instance.id, kind: 'maxlag', lag: 0, ffLag: 0, hold: src.output.hold, unitStream: null })
        }
      }
    }
  }

  // --- dish sink (spec §3.8) ---
  const hold = dishHold(recipe.serving, policy)
  const sinkId = `${dishId}:sink`
  const earlyTolerance = dish.earlyTolerance ?? 0
  const lateTolerance = dish.lateTolerance ?? DEFAULT_LATE_TOLERANCE_MS
  const serveTime = dish.serveTime ?? null
  const sink = {
    id: sinkId,
    dishId,
    recipeTaskId: null,
    operation: 'serve',
    title: `Serve ${recipe.title ?? dishId}`,
    instructions: `Serve ${recipe.title ?? dishId}`,
    units: scale,
    unitStream: null,
    batch: null,
    active: 0,
    passive: 0,
    timeModel: 'fixed',
    perUnit: 0,
    attention: 'attended',
    checkInterval: null,
    checkDuration: null,
    divisible: 'none',
    minChunk: 0,
    maxPeople: 1,
    speedup: 1,
    preemptible: 'never',
    resumeCost: 0,
    completion: null,
    context: { dish: dishId, station: 'counter', tool: null },
    tedium: 0,
    requires: [],
    tools: [],
    appliance: null,
    returnsTools: [],
    hold,
    outputs: [],
    inputs: [],
    kind: 'sink',
    serveWindow: serveTime != null ? { earliest: serveTime - earlyTolerance, latest: serveTime + lateTolerance } : null,
  }
  graph.tasks[sinkId] = sink
  for (const outputId of q.finalOutputs) {
    const src = outputs.get(outputId)
    const prod = records.get(src.task.id)
    const outputHold = src.output.hold != null && Number.isFinite(src.output.hold) ? Math.min(src.output.hold, hold) : hold
    sink.inputs.push({ ref: outputId, amount: prod.outputs.find((o) => o.id === outputId)?.amount ?? null })
    for (const { instance } of prod.instances) {
      addEdge({ from: instance.id, to: sinkId, kind: 'fs', lag: 0, ffLag: 0, hold: null, unitStream: null })
      if (Number.isFinite(outputHold)) addEdge({ from: instance.id, to: sinkId, kind: 'maxlag', lag: 0, ffLag: 0, hold: outputHold, unitStream: null })
    }
  }
  graph.dishes.push({
    id: dishId,
    recipeId: dish.recipeId ?? recipe.id,
    title: recipe.title ?? dishId,
    serveTime,
    earlyTolerance,
    lateTolerance,
    temperature: recipe.serving?.temperature ?? 'ambient',
    hold,
    sinkId,
  })

  // --- buffers for stream edges (spec §3.9, §5.2 step 2) ---
  const successors = new Map()
  for (const e of graph.edges) {
    if (e.kind === 'maxlag') continue
    if (!successors.has(e.from)) successors.set(e.from, [])
    successors.get(e.from).push(e.to)
  }
  const findRelease = (startId, carrierType) => {
    const queue = [startId]
    const visited = new Set(queue)
    while (queue.length > 0) {
      const id = queue.shift()
      const t = graph.tasks[id]
      if (t && t.returnsTools.includes(carrierType)) return id
      if (t && t.kind === 'sink') return 'served'
      // another carrier takes the units over (sheet → rack): the first one should have been returned
      const rec = t && t.recipeTaskId ? records.get(t.recipeTaskId) : null
      if (rec && rec.carrier && rec.carrier.type !== carrierType && id !== startId) return null
      for (const next of successors.get(id) ?? []) {
        if (!visited.has(next)) {
          visited.add(next)
          queue.push(next)
        }
      }
    }
    return null
  }
  for (const e of graph.edges) {
    if (e.kind !== 'stream' || graph.tasks[e.from].dishId !== dishId) continue
    const prodRecord = records.get(graph.tasks[e.from].recipeTaskId)
    const carrier = prodRecord.carrier
    if (carrier) {
      let releaseTask = findRelease(e.to, carrier.type)
      if (releaseTask === 'served') releaseTask = null // the carrier goes to the table with the food: nothing to return
      else if (!releaseTask) {
        pushDiagnostic(graph, seen, { code: 'CARRIER_NEVER_RETURNED', message: `Carrier '${carrier.type}' holding '${e.unitStream}' units from '${prodRecord.task.id}' is never returned by a downstream task`, dish: dishId, task: prodRecord.task.id })
      }
      graph.buffers.push({ from: e.from, to: e.to, carrier: carrier.type, capPerCarrier: carrier.cap, carriers: carrier.carriers, capacity: carrier.cap * carrier.carriers, releaseTask, station: null })
    } else {
      const area = counter?.area ?? null
      const count = counter?.count ?? 1
      if (area == null) {
        pushDiagnostic(graph, seen, { code: 'NO_CAPACITY', message: `No carrier and no counter area for '${e.unitStream}' units between '${e.from}' and '${e.to}'`, dish: dishId, task: prodRecord.task.id })
      }
      graph.buffers.push({ from: e.from, to: e.to, carrier: null, capPerCarrier: area ?? Infinity, carriers: count, capacity: area != null ? area * count : Infinity, releaseTask: null, station: 'counter' })
    }
  }
}

/** Operation metadata for a join: the last step's operation, titles concatenated. */
function joinOperation(task, resolveOp) {
  const steps = task.steps ?? []
  const ops = steps.map((s) => resolveOp(s))
  const last = ops[ops.length - 1] ?? operationWithDefaults('join', null)
  const perUnit = ops.some((o) => o.time.model === 'per-unit')
  const passive = ops.some((o) => o.time.passive > 0 || o.time.passiveFrom != null)
  return {
    ...last,
    name: 'join',
    title: ops.map((o) => o.title).join(' + ') || 'Join',
    attention: ops.find((o) => o.attention !== 'attended')?.attention ?? (passive ? 'unattended' : 'attended'),
    divisible: perUnit ? 'units' : 'none',
    preemptible: perUnit ? 'units' : last.preemptible,
    requires: uniq(ops.flatMap((o) => o.requires ?? [])),
    tedium: Math.max(1, ...ops.map((o) => o.tedium ?? 1)),
    station: last.station,
    expand: null,
  }
}

/** Kahn's algorithm over all edges; throws with the cycle spelled out. */
export function topologicalOrder(graph) {
  const ids = Object.keys(graph.tasks)
  const indeg = new Map(ids.map((id) => [id, 0]))
  const out = new Map(ids.map((id) => [id, []]))
  for (const e of graph.edges) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) throw new Error(`Edge ${e.from} → ${e.to} references an unknown task`)
    indeg.set(e.to, indeg.get(e.to) + 1)
    out.get(e.from).push(e.to)
  }
  const queue = ids.filter((id) => indeg.get(id) === 0)
  const order = []
  while (queue.length > 0) {
    const id = queue.shift()
    order.push(id)
    for (const next of out.get(id)) {
      indeg.set(next, indeg.get(next) - 1)
      if (indeg.get(next) === 0) queue.push(next)
    }
  }
  if (order.length !== ids.length) {
    const remaining = new Set(ids.filter((id) => !order.includes(id)))
    const stack = []
    const state = new Map()
    let cycle = null
    const visit = (id) => {
      if (cycle) return
      if (state.get(id) === 'active') {
        cycle = stack.slice(stack.indexOf(id)).concat(id)
        return
      }
      if (state.get(id) === 'done') return
      state.set(id, 'active')
      stack.push(id)
      for (const next of out.get(id)) if (remaining.has(next)) visit(next)
      stack.pop()
      state.set(id, 'done')
    }
    for (const id of remaining) visit(id)
    throw new Error(`Cycle in task graph: ${(cycle ?? [...remaining]).join(' → ')}`)
  }
  return order
}

// The recipe's capacity wins whenever the recipe states one: it is a fact about how many of THIS item fit (17 buns of
// this size on a sheet, 12 cookies spaced 5 cm apart), which a kitchen default cannot know. The inventory capacity
// is used only when the recipe gives none.
function pickCapacity(inventoryCapacity, recipeCapacity) {
  if (recipeCapacity && Number(recipeCapacity.number) > 0) return recipeCapacity
  return inventoryCapacity ?? null
}

/**
 * Build the task graph (Phases A and B) for every dish of a session.
 * @param {object} session Session (README §4); `inventory` defaults to `defaultInventory()`
 * @param {object} catalogue Catalogue (README §3)
 * @returns {object} Graph (README §5)
 */
export function buildGraph(session, catalogue) {
  const inventory = session.inventory ?? defaultInventory()
  const policy = session.policy ?? {}
  const graph = { tasks: {}, order: [], edges: [], buffers: [], dishes: [], diagnostics: [] }
  const seen = new Set()
  const ids = new Set()
  for (const dish of session.dishes ?? []) {
    const id = dish.id ?? dish.recipe?.id
    if (ids.has(id)) throw new Error(`Duplicate dish id '${id}' in session`)
    ids.add(id)
    buildDish({ ...dish, id }, session, catalogue, inventory, policy, graph, seen)
  }
  // storage freshness and, with mise en place, gathering steps (spec §3.10)
  applyIngredientHandling(graph, { ...session, dishes: (session.dishes ?? []).map((d) => ({ ...d, id: d.id ?? d.recipe?.id })) }, policy, (name) => operationWithDefaults(name, catalogue?.[name]))
  graph.order = topologicalOrder(graph)
  return graph
}

