// operations.xml → Catalogue (README §3). DOM access is limited to getElementsByTagName, childNodes, nodeType,
// nodeName, getAttribute, hasAttribute and textContent so the same code runs on the browser DOMParser and on
// @xmldom/xmldom.

const ELEMENT_NODE = 1

const TIME_MODELS = new Set(['fixed', 'per-unit', 'sub-linear'])
const PASSIVE_SOURCES = new Set(['duration', 'formula:heat', 'formula:preheat'])
const ATTENTIONS = new Set(['attended', 'monitored', 'unattended'])
const DIVISIBLES = new Set(['none', 'units', 'team'])
const PREEMPTIBLES = new Set(['never', 'units', 'anywhere'])
const URGENCIES = new Set(['critical', 'timed', 'relaxed'])
const SOILS = new Set(['none', 'rinse', 'wash'])
const STATIONS = new Set(['counter', 'hob', 'oven', 'sink', 'fridge', 'bar'])
const OPTION_TYPES = new Set(['numeric', 'text', 'boolean'])

/** Default check cadence for `monitored` operations that do not state one (spec §3.6). */
export const DEFAULT_CHECK_INTERVAL = 120
export const DEFAULT_CHECK_DURATION = 10

function attr(element, name, fallback = null) {
  return element.hasAttribute(name) ? element.getAttribute(name) : fallback
}

function numberAttr(element, name, fallback) {
  const raw = attr(element, name)
  if (raw === null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function boolAttr(element, name, fallback) {
  const raw = attr(element, name)
  if (raw === null) return fallback
  return raw === 'true' || raw === '1'
}

function enumAttr(element, name, allowed, fallback) {
  const raw = attr(element, name)
  return raw !== null && allowed.has(raw) ? raw : fallback
}

function childElements(element, name) {
  const out = []
  const nodes = element.childNodes
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.nodeType === ELEMENT_NODE && node.nodeName === name) out.push(node)
  }
  return out
}

function firstChild(element, name) {
  return childElements(element, name)[0] || null
}

function parseOptions(operationElement) {
  const options = {}
  const container = firstChild(operationElement, 'options')
  if (!container) return options
  for (const option of childElements(container, 'option')) {
    const name = attr(option, 'name')
    if (!name) continue
    options[name] = {
      required: boolAttr(option, 'required', false),
      type: enumAttr(option, 'type', OPTION_TYPES, 'numeric'),
      defaultUnit: attr(option, 'default-unit') ?? attr(option, 'unit') ?? null,
    }
  }
  return options
}

function parseTime(operationElement) {
  const timeline = firstChild(operationElement, 'timeline')
  const model = timeline ? enumAttr(timeline, 'model', TIME_MODELS, 'fixed') : 'fixed'
  const passiveFrom = timeline ? enumAttr(timeline, 'passive-from', PASSIVE_SOURCES, null) : null
  return {
    model,
    active: timeline ? numberAttr(timeline, 'active', 0) : 0,
    perUnit: timeline ? numberAttr(timeline, 'per-unit', 0) : 0,
    passive: timeline ? numberAttr(timeline, 'passive', 0) : 0,
    passiveFrom,
    byAmount: timeline ? parseByAmount(timeline) : null,
  }
}

// Seconds per kind of `amount` (measure): a spoon of spice, a few pieces, weighing on a scale, pouring a volume.
// They replace `per-unit` when the task's amount option is of that kind (see catalogue/durations.js amountKind).
const AMOUNT_KINDS = ['spoon', 'count', 'weigh', 'pour']
function parseByAmount(timeline) {
  const out = {}
  for (const k of AMOUNT_KINDS) {
    const v = numberAttr(timeline, k, null)
    if (v !== null && v >= 0) out[k] = v
  }
  return Object.keys(out).length ? out : null
}

function parseCompletion(operationElement) {
  const completion = firstChild(operationElement, 'completion')
  return {
    urgency: completion ? enumAttr(completion, 'urgency', URGENCIES, 'relaxed') : 'relaxed',
    early: completion ? numberAttr(completion, 'early', 0) : 0,
    late: completion ? numberAttr(completion, 'late', 300) : 300,
    duration: completion ? numberAttr(completion, 'duration', 30) : 30,
  }
}

function parseOperation(element) {
  const name = attr(element, 'name')
  const titleElement = firstChild(element, 'title')
  const time = parseTime(element)
  const hasPassive = time.passive > 0 || time.passiveFrom !== null

  const attention = enumAttr(element, 'attention', ATTENTIONS, hasPassive ? 'unattended' : 'attended')
  const divisible = enumAttr(element, 'divisible', DIVISIBLES, time.model === 'per-unit' ? 'units' : 'none')
  const preemptible = enumAttr(element, 'preemptible', PREEMPTIBLES, time.model === 'per-unit' ? 'units' : 'never')
  const requires = (attr(element, 'requires') || '').split(/\s+/).filter(Boolean)

  return {
    name,
    title: titleElement ? String(titleElement.textContent || '').trim() : name,
    minInputs: numberAttr(element, 'min-inputs', 0),
    maxInputs: numberAttr(element, 'max-inputs', null),
    minOutputs: numberAttr(element, 'min-outputs', 1),
    maxOutputs: numberAttr(element, 'max-outputs', null),
    requiresTools: boolAttr(element, 'requires-tools', false),
    options: parseOptions(element),
    time,
    attention,
    checkInterval: attention === 'monitored' ? numberAttr(element, 'check-interval', DEFAULT_CHECK_INTERVAL) : null,
    checkDuration: attention === 'monitored' ? numberAttr(element, 'check-duration', DEFAULT_CHECK_DURATION) : null,
    divisible,
    minChunk: numberAttr(element, 'min-chunk', 180),
    maxPeople: divisible === 'team' ? numberAttr(element, 'max-people', 2) : numberAttr(element, 'max-people', 1),
    speedup: numberAttr(element, 'speedup', 1),
    preemptible,
    resumeCost: numberAttr(element, 'resume-cost', 20),
    completion: parseCompletion(element),
    soil: enumAttr(element, 'soil', SOILS, 'rinse'),
    station: enumAttr(element, 'station', STATIONS, 'counter'),
    tedium: numberAttr(element, 'tedium', 1),
    requires,
    expand: attr(element, 'expand') || null,
  }
}

/**
 * Parse an operations.xml document into a Catalogue: `{ [operationName]: Operation }` as described in README §3.
 * Defaults: attention `attended` unless the operation has a passive part (then `unattended`); divisible and
 * preemptible `units` for the `per-unit` time model, else `none` / `never`; completion `relaxed` 0/300/30; soil
 * `rinse`; station `counter`; tedium 1; min-chunk 180; resume-cost 20.
 *
 * @param {string} xmlString contents of operations.xml
 * @param {{ DOMParser: typeof DOMParser }} env a DOMParser constructor (browser or @xmldom/xmldom)
 * @returns {Record<string, object>} the catalogue
 */
export function loadCatalogue(xmlString, { DOMParser } = {}) {
  if (typeof DOMParser !== 'function') throw new Error('loadCatalogue needs a DOMParser constructor')
  const doc = new DOMParser().parseFromString(String(xmlString), 'text/xml')
  const elements = doc.getElementsByTagName('operation')
  const catalogue = {}
  for (let i = 0; i < elements.length; i++) {
    const operation = parseOperation(elements[i])
    if (!operation.name) continue
    catalogue[operation.name] = operation
  }
  return catalogue
}
