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

function diagnosticText(d) {
  return `[${d.code || 'NOTE'}] ${d.message || ''}`.trim()
}

function runPlan({ id, xml, operationsXml, participants }) {
  const session = {
    id: 'import-dry-run',
    startTime: null,
    now: DRY_RUN_START,
    dishes: [{ id, recipeId: id, scale: 1, serveTime: DRY_RUN_START + 6 * 3600 * 1000, earlyTolerance: 0, lateTolerance: 300000 }],
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
  const { graph, plan } = scheduler.planSession({ recipes: { [id]: xml }, operationsXml, session, DOMParser: QuietDOMParser })
  const items = plan.lanes.flatMap((l) => l.items).filter((it) => it.kind !== 'idle' && it.kind !== 'blocked')
  const start = items.length ? Math.min(...items.map((it) => it.start)) : plan.startTime
  const end = items.length ? Math.max(...items.map((it) => it.passiveUntil || it.end)) : plan.startTime
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
  const diagnostics = []
  for (const d of [...(graph.diagnostics || []), ...(plan.diagnostics || [])]) {
    const t = diagnosticText(d)
    if (!diagnostics.includes(t)) diagnostics.push(t)
  }
  const serious = [...(graph.diagnostics || []), ...(plan.diagnostics || [])].filter((d) => SERIOUS_PLAN_CODES.has(d.code))
  const dish = plan.dishes[0] || {}
  return {
    participants,
    ok: serious.length === 0,
    makespanSeconds: Math.round((end - start) / 1000),
    activeSeconds: Math.round(activeMs / 1000),
    tasks: Object.values(graph.tasks).filter((t) => t.kind !== 'sink').length,
    lateSeconds: dish.late ?? null,
    chains,
    diagnostics,
  }
}

/**
 * Dry-run the scheduler on one recipe with 1 and 3 cooks (default inventory, serve 6 h after the start).
 * Top-level fields describe the 1-cook run, except `chains`, which come from the 3-cook run (pipelines are only
 * organised when there are several cooks); `runs` holds both runs.
 */
export function dryRunPlan({ id, xml, operationsXml = loadOperationsXml(), participants = DRY_RUN_PARTICIPANTS } = {}) {
  const runs = []
  try {
    for (const n of participants) runs.push(runPlan({ id, xml, operationsXml, participants: n }))
  } catch (e) {
    return { ok: false, makespanSeconds: null, activeSeconds: null, tasks: null, chains: [], diagnostics: [], error: `Scheduler failed: ${e && e.message ? e.message : String(e)}`, runs }
  }
  const first = runs[0]
  const multi = runs.find((r) => r.participants > 1) || first
  const diagnostics = []
  for (const r of runs) for (const d of r.diagnostics) {
    const t = runs.length > 1 ? `${r.participants} cook${r.participants > 1 ? 's' : ''}: ${d}` : d
    if (!diagnostics.includes(t)) diagnostics.push(t)
  }
  return {
    ok: runs.every((r) => r.ok),
    makespanSeconds: first.makespanSeconds,
    activeSeconds: first.activeSeconds,
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
