// checkRecipeXml: well-formedness, parse + validate against the catalogue, unit lint and a scheduler dry run.
// Never throws on bad input; every problem ends up in `errors`.

import { DOMParser as XmldomParser } from '@xmldom/xmldom'
import * as scheduler from '@flow-recipe/scheduler'
import { checkWellFormed } from './wellformed.js'
import { loadOperationsXml } from './guide.js'
import { recipeVocabularyErrors } from './vocabulary.js'

/** xmldom DOMParser that does not print warnings to the console (problems are collected by checkWellFormed). */
export class QuietDOMParser extends XmldomParser {
  constructor(options = {}) {
    super({ locator: {}, errorHandler: { warning() {}, error() {}, fatalError() {} }, ...options })
  }
}

export const DRY_RUN_PARTICIPANTS = [1, 3]
/** Limits that bound the work of one check (the largest built-in recipe has 46 tasks, 17 ingredients, 31 kB). */
export const MAX_TASKS = 150
export const MAX_INGREDIENTS = 100
export const MAX_XML_CHARS = 500000
const DRY_RUN_START = Date.UTC(2026, 0, 10, 9, 0, 0)
const SERIOUS_PLAN_CODES = new Set(['INVARIANT', 'DEADLOCK', 'INCOMPLETE'])
const BUSY_KINDS = new Set(['work', 'cleaning', 'appointment', 'check', 'setup', 'resume'])

let catalogueCache = { xml: null, catalogue: null }

/** The catalogue for an operations XML string (cached on the string). */
export function catalogueFor(operationsXml) {
  if (catalogueCache.xml !== operationsXml) {
    catalogueCache = { xml: operationsXml, catalogue: scheduler.loadCatalogue(operationsXml, { DOMParser: QuietDOMParser }) }
  }
  return catalogueCache.catalogue
}

/** The conversion functions from @flow-recipe/scheduler (WP-A), or null when the installed scheduler lacks them. */
export function conversions() {
  const { metricizeRecipeXml, lintRecipeUnits, toMetricAmount } = scheduler
  if (typeof metricizeRecipeXml !== 'function' || typeof lintRecipeUnits !== 'function') return null
  return { metricizeRecipeXml, lintRecipeUnits, toMetricAmount }
}

export const CONVERSIONS_MISSING =
  'Unit conversion is unavailable: @flow-recipe/scheduler does not export metricizeRecipeXml/lintRecipeUnits (update the scheduler package)'

function leafTasks(model) {
  const out = []
  for (const t of model.tasks || []) {
    if (t.operation === 'join' && Array.isArray(t.steps)) for (const s of t.steps) out.push({ task: s, joinId: t.id })
    else out.push({ task: t, joinId: null })
  }
  return out
}

function rootAttributes(xml) {
  const doc = new QuietDOMParser().parseFromString(xml, 'text/xml')
  const root = doc && doc.documentElement
  if (!root) return { doc }
  const get = (n) => (root.hasAttribute(n) ? root.getAttribute(n) : null)
  return { doc, name: root.nodeName, version: get('version'), id: get('id'), ref: get('ref') }
}

function summarise(model, catalogue) {
  const leaves = leafTasks(model)
  const consumed = new Set(leaves.flatMap(({ task }) => task.inputs.map((i) => i.ref)))
  const ingredients = model.ingredients.map((ing) => ({
    id: ing.id,
    name: ing.name,
    storage: ing.properties && ing.properties.storage ? ing.properties.storage.value || null : null,
    amounts: [],
  }))
  const byId = new Map(ingredients.map((i) => [i.id, i]))
  const tasks = []
  const finalOutputs = []
  for (const { task, joinId } of leaves) {
    const op = catalogue ? catalogue[task.operation] : null
    if (task.operation === 'measure' && task.options.amount) {
      for (const input of task.inputs) {
        const ing = byId.get(input.ref)
        if (ing) ing.amounts.push({ number: task.options.amount.number ?? null, unit: task.options.amount.unit ?? null, taskId: task.id })
      }
    }
    const unitOut = task.outputs.find((o) => o.unit)
    const firstOut = task.outputs[0]
    tasks.push({
      id: task.id,
      operation: task.operation,
      title: `${op && op.title ? op.title : task.operation}${firstOut && firstOut.name ? `: ${firstOut.name}` : ''}`,
      units: unitOut && unitOut.amount !== null ? unitOut.amount : null,
      unitStream: unitOut ? unitOut.unit : null,
      join: joinId,
      options: Object.fromEntries(Object.entries(task.options).map(([k, v]) => [k, v.number !== undefined && v.number !== null ? `${v.number}${v.unit ? ` ${v.unit}` : ''}` : v.text || ''])),
      requires: task.requires,
    })
    for (const o of task.outputs) {
      if (o.final || !consumed.has(o.id)) finalOutputs.push({ id: o.id, name: o.name, taskId: task.id, amount: o.amount, unit: o.unit, explicit: !!o.final })
    }
  }
  const reserved = new Set(leaves.flatMap(({ task }) => task.tools.filter((t) => t.reserved).map((t) => t.ref)))
  const returned = new Set(leaves.flatMap(({ task }) => task.returnsTools.map((t) => t.ref)))
  const tools = model.tools.map((t) => ({ id: t.id, name: t.name, type: t.type, capacity: t.capacity, reserved: reserved.has(t.id), returned: returned.has(t.id) }))
  return { ingredients, tasks, tools, serving: model.serving, finalOutputs }
}

const HEAT_STATIONS = new Set(['hob', 'oven', 'microwave', 'grill'])
/** Warnings from vesselOrderWarnings start with this, so the repair loop can recognise them. */
export const VESSEL_ORDER_PREFIX = 'Vessel order:'

/**
 * One-pot ordering: two tasks that hold the same reserved vessel (a pot, a pan, a single bowl) must be ordered by
 * the data, or the scheduler may run them in either order or treat them as one container. Warns for every pair
 * of non-measure tasks that reserve the same tool id with no input path between them, unless one of the uses
 * ends with the tool being returned before the branches meet, and (for a tool the kitchen has several of) unless
 * the two tasks are not both on the hob.
 */
export function vesselOrderWarnings(model, catalogue, inventory = scheduler.defaultInventory()) {
  const leaves = leafTasks(model).map(({ task }) => task)
  const producer = new Map()
  for (const t of leaves) for (const o of t.outputs) producer.set(o.id, t.id)
  const preds = new Map(leaves.map((t) => [t.id, new Set(t.inputs.map((i) => producer.get(i.ref)).filter((x) => x && x !== t.id))]))
  const ancestors = new Map()
  const ancestorsOf = (id, stack = new Set()) => {
    if (ancestors.has(id)) return ancestors.get(id)
    const out = new Set()
    if (stack.has(id)) return out
    stack.add(id)
    for (const p of preds.get(id) || []) {
      out.add(p)
      for (const a of ancestorsOf(p, stack)) out.add(a)
    }
    stack.delete(id)
    ancestors.set(id, out)
    return out
  }
  const toolType = new Map((model.tools || []).map((t) => [t.id, t.type || t.id]))
  const station = (t) => {
    const op = catalogue ? catalogue[t.operation] : null
    return op ? op.station || (op.expand ? 'oven' : null) : null
  }
  const heat = (t) => HEAT_STATIONS.has(station(t))
  const isDescOrSelf = (x, of) => x === of || ancestorsOf(x).has(of)
  const returners = new Map()
  for (const t of leaves) for (const r of t.returnsTools || []) {
    if (!returners.has(r.ref)) returners.set(r.ref, [])
    returners.get(r.ref).push(t.id)
  }
  // a use of the vessel that is returned before the two branches meet is a separate use (wash, reuse)
  const separateUse = (ref, a, b) =>
    (returners.get(ref) || []).some((r) => isDescOrSelf(r, a.id) !== isDescOrSelf(r, b.id))
  const byTool = new Map()
  for (const t of leaves) {
    if (t.operation === 'measure') continue
    for (const tool of t.tools || []) {
      if (!tool.reserved) continue
      if (!byTool.has(tool.ref)) byTool.set(tool.ref, [])
      if (!byTool.get(tool.ref).includes(t)) byTool.get(tool.ref).push(t)
    }
  }
  const warnings = []
  for (const [ref, tasks] of byTool) {
    const count = scheduler.toolCount(inventory, toolType.get(ref) || ref)
    const reported = new Set()
    for (let i = 0; i < tasks.length; i++) {
      const a = tasks[i]
      if (reported.has(a.id)) continue
      const unordered = []
      for (let j = i + 1; j < tasks.length; j++) {
        const b = tasks[j]
        if (ancestorsOf(b.id).has(a.id) || ancestorsOf(a.id).has(b.id)) continue
        if (count > 1 && !(station(a) === 'hob' && station(b) === 'hob')) continue
        if (separateUse(ref, a, b)) continue
        unordered.push(b.id)
      }
      if (!unordered.length) continue
      for (const id of unordered) reported.add(id)
      const b = unordered[0]
      const others = unordered.length > 1 ? `'${unordered.join("', '")}'` : `'${b}'`
      warnings.push(
        `${VESSEL_ORDER_PREFIX} task '${a.id}' and ${unordered.length > 1 ? 'tasks ' : 'task '}${others} ${unordered.length > 1 ? 'all' : 'both'} hold the '${ref}' (reserved), but no input path links ${unordered.length > 1 ? 'them' : 'the two'} to '${a.id}', so the scheduler may run them in either order or at the same time. ` +
          `If '${b}' cooks in the same ${ref} after '${a.id}', give '${a.id}' an extra output for the used vessel (e.g. "${ref}-with-fond") and make it an input of '${b}' (RECIPE.spec.md §7, one vessel for several steps); if they are different vessels, give the second its own tool id.`,
      )
      if (warnings.length >= 6) return warnings
    }
  }
  return warnings
}

/** Warnings that the import's repair loop sends back to the model even when the check has no errors. */
export function repairWorthyWarnings(check) {
  if (!check) return []
  const out = (check.warnings || []).filter((w) => typeof w === 'string' && w.startsWith(VESSEL_ORDER_PREFIX))
  for (const l of check.unitLint || []) {
    if (l && l.level === 'warning' && /is not recognised|is ambiguous/.test(l.message || '')) out.push(`${l.taskId ? `Task '${l.taskId}': ` : ''}${l.message}`)
  }
  return out
}

function diagnosticText(d) {
  return `[${d.code || 'NOTE'}] ${d.message || ''}`.trim()
}

// Diagnostics that only describe the dry run's artificial serve time (serve as soon as possible), not the recipe.
const DRY_RUN_ARTIFACT_CODES = new Set(['LATE', 'CRITICAL_PATH', 'START_EARLIER', 'REPAIR_DELAY', 'REPAIR_START', 'REPAIR_SLACK', 'REPAIR_FLOAT', 'REPAIR_SPREAD', 'REPAIR_CHUNK'])

function dryRunSession({ id, participants, serveTime, recipe }) {
  return {
    id: 'import-dry-run',
    startTime: null,
    now: DRY_RUN_START,
    dishes: [{ id, recipeId: id, recipe, scale: 1, serveTime, earlyTolerance: 0, lateTolerance: 300000 }],
    participants: Array.from({ length: participants }, (_, i) => ({
      id: i === 0 ? '0' : `p${i + 1}`,
      name: `Cook ${i + 1}`,
      availability: null,
      speed: 1,
      capabilities: null,
      role: 'cook',
      targetShare: 1,
      maxConcurrentTimers: 2,
      placeholder: false,
    })),
    inventory: scheduler.defaultInventory(),
    policy: {},
  }
}

/**
 * The critical path in seconds: the elapsed time with unlimited cooks and tools (resource-free forward pass over
 * the task graph, durations from the catalogue).
 */
function criticalPathSeconds(graph) {
  const { windows } = scheduler.computeWindows(graph, DRY_RUN_START, {})
  let cp = 0
  for (const w of Object.values(windows)) if (Number.isFinite(w.ES) && Number.isFinite(w.duration)) cp = Math.max(cp, w.ES + w.duration)
  return cp
}

/**
 * One dry run, planned as soon as possible: the serve time is the start plus the critical path, so the planner
 * schedules forward from the start instead of spreading the work towards a far serve time. The makespan is the time
 * from the first item to the planned serve (or the last item when the dish has no planned serve).
 */
function runPlan({ id, recipe, catalogue, participants, cpSeconds }) {
  const session = dryRunSession({ id, participants, serveTime: DRY_RUN_START + Math.ceil(cpSeconds) * 1000, recipe })
  const graph = scheduler.buildGraph(session, catalogue)
  const plan = scheduler.plan(graph, session)
  const items = plan.lanes.flatMap((l) => l.items).filter((it) => it.kind !== 'idle' && it.kind !== 'blocked')
  const start = items.length ? Math.min(...items.map((it) => it.start)) : plan.startTime
  const lastEnd = items.length ? Math.max(...items.map((it) => it.passiveUntil || it.end)) : plan.startTime
  const dish = plan.dishes[0] || {}
  const end = Number.isFinite(dish.plannedServe) ? dish.plannedServe : lastEnd
  const activeMs = items.filter((it) => BUSY_KINDS.has(it.kind)).reduce((a, it) => a + Math.max(0, it.end - it.start), 0)
  const stageMap = new Map()
  try {
    for (const c of scheduler.detectChains(graph)) stageMap.set(c.id, c.stages.map((s) => s.recipeTaskId))
  } catch {
    // chain detection is informative only
  }
  const chains = (plan.report.chains || []).map((c) => ({
    id: c.chainId,
    stream: c.stream,
    units: c.units,
    stages: stageMap.get(c.chainId) || [],
    organisation: c.organisation,
    workforce: c.workforce,
  }))
  const all = [...(graph.diagnostics || []), ...(plan.diagnostics || [])].filter((d) => !DRY_RUN_ARTIFACT_CODES.has(d.code))
  const diagnostics = []
  const seen = new Set()
  for (const d of all) {
    // the same tool note comes from several tasks, with and without a trailing period
    const t = diagnosticText(d).replace(/\.$/, '')
    if (!seen.has(t)) {
      seen.add(t)
      diagnostics.push(t)
    }
  }
  const serious = all.filter((d) => SERIOUS_PLAN_CODES.has(d.code))
  return {
    participants,
    ok: serious.length === 0,
    makespanSeconds: Math.round((end - start) / 1000),
    activeSeconds: Math.round(activeMs / 1000),
    tasks: Object.values(graph.tasks).filter((t) => t.kind !== 'sink').length,
    chains,
    diagnostics,
  }
}

/**
 * Dry-run the scheduler on one recipe with 1 and 3 cooks (default inventory), planned as soon as possible.
 * Top-level fields describe the 1-cook run, except `chains`, which come from the 3-cook run (pipelines are only
 * organised when there are several cooks); `runs` holds every run as { participants, makespanSeconds,
 * activeSeconds, ... }; `criticalPathSeconds` is the elapsed time with unlimited cooks and tools.
 */
export function dryRunPlan({ id, xml, operationsXml = loadOperationsXml(), participants = DRY_RUN_PARTICIPANTS } = {}) {
  const runs = []
  let cpSeconds = null
  try {
    const catalogue = catalogueFor(operationsXml)
    const recipe = scheduler.parseRecipe(xml, { DOMParser: QuietDOMParser, id })
    const probe = dryRunSession({ id, participants: 1, serveTime: DRY_RUN_START + 6 * 3600 * 1000, recipe })
    cpSeconds = criticalPathSeconds(scheduler.buildGraph(probe, catalogue))
    for (const n of participants) runs.push(runPlan({ id, recipe, catalogue, participants: n, cpSeconds }))
  } catch (e) {
    return { ok: false, makespanSeconds: null, activeSeconds: null, criticalPathSeconds: null, tasks: null, chains: [], diagnostics: [], error: `Scheduler failed: ${e && e.message ? e.message : String(e)}`, runs }
  }
  const first = runs[0]
  const multi = runs.find((r) => r.participants > 1) || first
  const diagnostics = []
  // a note that every run reports is listed once; a note from one run only is prefixed with its team size
  const everyRun = (d) => runs.every((r) => r.diagnostics.includes(d))
  for (const r of runs) for (const d of r.diagnostics) {
    const t = runs.length > 1 && !everyRun(d) ? `${r.participants} cook${r.participants > 1 ? 's' : ''}: ${d}` : d
    if (!diagnostics.includes(t)) diagnostics.push(t)
  }
  return {
    ok: runs.every((r) => r.ok),
    makespanSeconds: first.makespanSeconds,
    activeSeconds: first.activeSeconds,
    criticalPathSeconds: Math.round(cpSeconds),
    tasks: first.tasks,
    chains: multi.chains,
    diagnostics,
    runs,
  }
}

/**
 * Check recipe XML: well-formedness (with line numbers), parseRecipe + validateRecipe against the catalogue,
 * lintRecipeUnits, and a scheduler dry run. Never throws.
 * @param {string} xml
 * @param {{ precisionScale?: boolean, id?: string, planCheck?: boolean, operationsXml?: string }} [options]
 * @returns {object} CheckResult = { ok, id, title, errors, warnings, unitLint, summary, plan }
 */
export function checkRecipeXml(xml, { precisionScale = false, id, planCheck = true, operationsXml } = {}) {
  const result = { ok: false, id: id || null, title: null, errors: [], warnings: [], unitLint: [], summary: null, plan: null }
  try {
    if (typeof xml !== 'string' || !xml.trim()) {
      result.errors.push('No XML given')
      return result
    }
    if (xml.length > MAX_XML_CHARS) {
      result.errors.push(`The XML is too large (${xml.length} characters; at most ${MAX_XML_CHARS})`)
      return result
    }
    const problems = checkWellFormed(xml)
    if (problems.length) {
      for (const p of problems) result.errors.push(`XML is not well-formed at line ${p.line}, column ${p.column}: ${p.message}`)
      return result
    }
    const root = rootAttributes(xml)
    if (root.name !== 'recipe') {
      result.errors.push(`The root element must be <recipe>, got <${root.name || '?'}>`)
      return result
    }
    // Only the recipe vocabulary: no foreign namespaces (XHTML <script>), no <?xml-stylesheet?>, no DOCTYPE.
    const foreign = recipeVocabularyErrors(root.doc)
    if (foreign.length) {
      result.errors.push(...foreign)
      return result
    }
    if (root.version !== '2') result.warnings.push(`<recipe> should have version="2"${root.version ? ` (has "${root.version}")` : ''}`)

    let ops
    let catalogue = null
    try {
      ops = operationsXml || loadOperationsXml()
      catalogue = catalogueFor(ops)
    } catch (e) {
      result.warnings.push(`Operation catalogue unavailable, operations not checked: ${e.message}`)
    }

    let model
    try {
      model = scheduler.parseRecipe(xml, { DOMParser: QuietDOMParser, id: id || undefined })
    } catch (e) {
      result.errors.push(e && e.message ? e.message : String(e))
      return result
    }
    result.id = id || model.id
    result.title = model.title || null
    if (!model.title) result.errors.push('The recipe has no <title>')
    if (!model.tasks.length) result.errors.push('The recipe has no tasks')
    // Planning budget: the dry run is synchronous and grows with the task count; real recipes stay far below.
    const taskCount = leafTasks(model).length
    if (taskCount > MAX_TASKS) result.errors.push(`The recipe has ${taskCount} tasks; at most ${MAX_TASKS} are supported`)
    if (model.ingredients.length > MAX_INGREDIENTS) result.errors.push(`The recipe has ${model.ingredients.length} ingredients; at most ${MAX_INGREDIENTS} are supported`)
    if (result.errors.length && (taskCount > MAX_TASKS || model.ingredients.length > MAX_INGREDIENTS)) return result

    const validation = scheduler.validateRecipe(model, catalogue || undefined)
    result.errors.push(...validation.errors)
    result.warnings.push(...validation.warnings)
    result.summary = catalogue ? summarise(model, catalogue) : summarise(model, null)
    try {
      result.warnings.push(...vesselOrderWarnings(model, catalogue))
    } catch (e) {
      result.warnings.push(`Vessel order check failed: ${e.message}`)
    }

    const conv = conversions()
    if (conv) {
      try {
        result.unitLint = conv.lintRecipeUnits(model, { precisionScale }) || []
      } catch (e) {
        result.warnings.push(`Unit lint failed: ${e.message}`)
      }
    } else {
      result.warnings.push(CONVERSIONS_MISSING)
    }

    if (planCheck && result.errors.length === 0 && catalogue) {
      result.plan = dryRunPlan({ id: result.id, xml, operationsXml: ops })
      if (result.plan.error) result.errors.push(result.plan.error)
      else if (!result.plan.ok) {
        const codes = [...new Set(result.plan.diagnostics.map((d) => (/\[(INVARIANT|DEADLOCK|INCOMPLETE)\]/.exec(d) || [])[1]).filter(Boolean))]
        result.warnings.push(`The scheduler dry run could not schedule the recipe cleanly (${codes.join(', ')}); see the plan diagnostics`)
      }
    }
  } catch (e) {
    result.errors.push(`Unexpected checker failure: ${e && e.message ? e.message : String(e)}`)
  }
  result.ok = result.errors.length === 0
  return result
}
