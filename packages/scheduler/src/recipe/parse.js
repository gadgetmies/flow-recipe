// Recipe XML (format v2, see packages/server/src/recipes/recipe.xsd) → RecipeModel (README §2).
//
// Works with the browser DOMParser and with @xmldom/xmldom: only getElementsByTagName, childNodes, nodeType,
// nodeName, getAttribute, hasAttribute and textContent are used. Direct children are found by walking childNodes
// because getElementsByTagName is recursive.

import { canonicalUnit, toSeconds } from '../units.js'

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const CDATA_SECTION_NODE = 4

/** Attribute value, or null when the attribute is absent (xmldom returns '' for missing attributes). */
function attr(el, name) {
  return el.hasAttribute(name) ? el.getAttribute(name) : null
}

function numberAttr(el, name) {
  const v = attr(el, name)
  if (v === null || v.trim() === '') return null
  const n = Number(v)
  if (Number.isNaN(n)) throw new Error(`Attribute ${name}="${v}" on <${el.nodeName}> is not a number`)
  return n
}

function booleanAttr(el, name, fallback) {
  const v = attr(el, name)
  if (v === null) return fallback
  const k = v.trim().toLowerCase()
  return k === 'true' || k === '1'
}

/** Direct element children, optionally filtered by element name. */
function children(el, name) {
  const out = []
  const nodes = el.childNodes
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.nodeType === ELEMENT_NODE && (name === undefined || n.nodeName === name)) out.push(n)
  }
  return out
}

function child(el, name) {
  return children(el, name)[0] || null
}

/** The element's own name: its direct text nodes joined and trimmed (mixed content keeps child elements out). */
function ownText(el) {
  let s = ''
  const nodes = el.childNodes
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.nodeType === TEXT_NODE || n.nodeType === CDATA_SECTION_NODE) s += n.textContent
  }
  return collapse(s)
}

function collapse(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function kebab(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function splitList(s) {
  return collapse(s).split(' ').filter(Boolean)
}

// ---------------------------------------------------------------------------------------------------------------
// Leaf elements

function parseNumericValue(el) {
  const value = { number: numberAttr(el, 'number') }
  const unit = attr(el, 'unit')
  if (unit !== null && unit.trim() !== '') value.unit = canonicalUnit(unit)
  return value
}

/** `<option name="x">` → { number, unit? } for a numeric-value child, else { text }. */
function parseOption(el) {
  const numeric = child(el, 'numeric-value')
  if (numeric) return parseNumericValue(numeric)
  const text = child(el, 'text-content')
  return { text: text ? collapse(text.textContent) : '' }
}

function parseOptions(el) {
  const options = {}
  for (const opt of children(el, 'option')) {
    const name = attr(opt, 'name')
    if (!name) throw new Error(`<option> without a name in <${el.nodeName}>`)
    options[name] = parseOption(opt)
  }
  return options
}

/** `<properties>` → { [name]: { value?, number?, unit? } }. */
function parseProperties(el) {
  const properties = {}
  if (!el) return properties
  for (const prop of children(el, 'property')) {
    const name = attr(prop, 'name')
    if (!name) throw new Error('<property> without a name')
    const numeric = child(prop, 'numeric-value')
    const text = child(prop, 'text-content')
    const value = attr(prop, 'value')
    const p = {}
    if (value !== null) p.value = value
    if (numeric) Object.assign(p, parseNumericValue(numeric))
    else if (text) p.value = collapse(text.textContent)
    properties[name] = p
  }
  return properties
}

function parseInputRef(el) {
  const ref = attr(el, 'ref')
  if (!ref) throw new Error('<input> without a ref')
  return { ref, amount: numberAttr(el, 'amount'), text: ownText(el) || null }
}

function parseToolRef(el) {
  const ref = attr(el, 'ref')
  if (!ref) throw new Error('<tool> reference without a ref')
  const amount = numberAttr(el, 'amount')
  const qty = numberAttr(el, 'qty')
  return {
    ref,
    reserved: booleanAttr(el, 'reserved', false),
    amount: amount === null ? 1 : amount,
    soil: attr(el, 'soil'),
    qty: qty === null ? 1 : qty,
  }
}

function parseOutput(el) {
  const id = attr(el, 'id')
  if (!id) throw new Error('<output> without an id')
  const hold = numberAttr(el, 'hold')
  const volume = numberAttr(el, 'volume')
  return {
    id,
    name: ownText(el) || null,
    amount: numberAttr(el, 'amount'),
    unit: attr(el, 'unit'),
    hold: hold === null ? null : toSeconds({ number: hold, unit: attr(el, 'hold-unit') || 'minutes' }),
    volume: volume === null ? null : { number: volume, unit: canonicalUnit(attr(el, 'volume-unit') || 'l') },
    final: booleanAttr(el, 'final', false),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tasks

/** Collects refs in order, deduped by ref; the first occurrence wins but a later amount fills a missing one. */
function addInput(list, input) {
  const existing = list.find((i) => i.ref === input.ref)
  if (!existing) {
    list.push(input)
    return
  }
  if (existing.amount === null && input.amount !== null) existing.amount = input.amount
  if (existing.text === null && input.text !== null) existing.text = input.text
}

function addTool(list, tool) {
  const existing = list.find((t) => t.ref === tool.ref)
  if (!existing) {
    list.push(tool)
    return
  }
  existing.reserved = existing.reserved || tool.reserved
  if (existing.soil === null) existing.soil = tool.soil
  existing.qty = Math.max(existing.qty, tool.qty)
}

function addOutput(list, output, taskId) {
  if (list.some((o) => o.id === output.id)) throw new Error(`Task '${taskId}' declares output '${output.id}' twice`)
  list.push(output)
}

function addReturnedTool(list, el) {
  const ref = attr(el, 'ref')
  if (!ref) throw new Error('<tool> reference without a ref')
  if (list.some((t) => t.ref === ref)) return
  list.push({ ref, name: attr(el, 'name') || ownText(el) || null })
}

function parseInstructions(el, task) {
  const items = []
  const nodes = el.childNodes
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.nodeType === TEXT_NODE || n.nodeType === CDATA_SECTION_NODE) {
      const text = collapse(n.textContent)
      if (text) items.push({ text })
      continue
    }
    if (n.nodeType !== ELEMENT_NODE) continue
    switch (n.nodeName) {
      case 'input': {
        const input = parseInputRef(n)
        addInput(task.inputs, input)
        items.push(input.amount === null ? { input: input.ref } : { input: input.ref, amount: input.amount })
        break
      }
      case 'tool': {
        const tool = parseToolRef(n)
        addTool(task.tools, tool)
        items.push({ tool: tool.ref })
        break
      }
      case 'output': {
        const output = parseOutput(n)
        addOutput(task.outputs, output, task.id)
        items.push({ output: output.id })
        break
      }
      case 'option': {
        const name = attr(n, 'name')
        if (!name) throw new Error(`<option> without a name in <instructions> of task '${task.id}'`)
        if (child(n, 'numeric-value') || child(n, 'text-content') || !(name in task.options)) {
          task.options[name] = parseOption(n)
        }
        items.push({ option: name })
        break
      }
      default:
        throw new Error(`Unexpected <${n.nodeName}> in <instructions> of task '${task.id}'`)
    }
  }
  return items
}

function parseTask(el, ctx) {
  const operation = attr(el, 'operation')
  const index = ctx.nextIndex()
  const id = attr(el, 'id') || `${ctx.recipeId}:t${index}`
  if (!operation) throw new Error(`Task '${id}' has no operation`)
  if (operation === 'batch' || child(el, 'tasks')) throw legacyBatchError(el, ctx, null, id)
  const task = {
    id,
    operation,
    options: {},
    inputs: [],
    tools: [],
    outputs: [],
    returnsTools: [],
    instructions: null,
    requires: splitList(attr(el, 'requires')),
  }

  // Pass 1: containers and task-level refs in document order; instructions come after (README §2).
  const instructionElements = []
  for (const c of children(el)) {
    switch (c.nodeName) {
      case 'options':
        Object.assign(task.options, parseOptions(c))
        break
      case 'inputs':
        for (const i of children(c, 'input')) addInput(task.inputs, parseInputRef(i))
        break
      case 'input':
        addInput(task.inputs, parseInputRef(c))
        break
      case 'tools':
        for (const t of children(c, 'tool')) addTool(task.tools, parseToolRef(t))
        break
      case 'tool':
        addTool(task.tools, parseToolRef(c))
        break
      case 'outputs':
        for (const o of children(c)) {
          if (o.nodeName === 'output') addOutput(task.outputs, parseOutput(o), id)
          else if (o.nodeName === 'tool') addReturnedTool(task.returnsTools, o)
          else throw new Error(`Unexpected <${o.nodeName}> in <outputs> of task '${id}'`)
        }
        break
      case 'output':
        addOutput(task.outputs, parseOutput(c), id)
        break
      case 'instructions':
        instructionElements.push(c)
        break
      default:
        throw new Error(`Unexpected <${c.nodeName}> in task '${id}'`)
    }
  }

  // Pass 2: instructions.
  if (instructionElements.length > 0) {
    task.instructions = []
    for (const ins of instructionElements) task.instructions.push(...parseInstructions(ins, task))
  }
  return task
}

/** Flattens a `<join>` into one task with `steps`; see README §2. */
function parseJoin(el, ctx) {
  const index = ctx.nextIndex()
  const id = attr(el, 'id') || `${ctx.recipeId}:join${index}`
  const steps = []
  for (const c of children(el)) {
    if (c.nodeName === 'task') steps.push(parseTask(c, ctx))
    else if (c.nodeName === 'batch') throw legacyBatchError(c, ctx, id)
    else throw new Error(`Unexpected <${c.nodeName}> in join '${id}'`)
  }
  if (steps.length === 0) throw new Error(`Join '${id}' has no tasks`)

  const produced = new Set()
  const consumed = new Set()
  const inputs = []
  const tools = []
  const returnsTools = []
  const requires = []
  for (const step of steps) {
    for (const input of step.inputs) {
      if (!produced.has(input.ref)) addInput(inputs, { ...input })
      consumed.add(input.ref)
    }
    for (const tool of step.tools) addTool(tools, { ...tool })
    for (const rt of step.returnsTools) if (!returnsTools.some((t) => t.ref === rt.ref)) returnsTools.push({ ...rt })
    for (const r of step.requires) if (!requires.includes(r)) requires.push(r)
    for (const output of step.outputs) produced.add(output.id)
  }
  const outputs = []
  steps.forEach((step, i) => {
    const later = steps.slice(i + 1)
    for (const output of step.outputs) {
      if (!later.some((s) => s.inputs.some((input) => input.ref === output.id))) outputs.push({ ...output })
    }
  })
  return {
    id,
    operation: 'join',
    options: {},
    inputs,
    tools,
    outputs,
    returnsTools,
    instructions: null,
    requires,
    steps,
  }
}

/**
 * The v1 batch wrapper came in two spellings: a `<batch>` element and `<task operation="batch">`, both with a
 * nested `<tasks>`. Neither is part of format v2.
 */
function legacyBatchError(el, ctx, parentId, taskId) {
  const id = taskId || attr(el, 'id')
  const form = el.nodeName === 'batch' ? '<batch> element' : `<task operation="batch"> with nested <tasks>`
  const where = parentId ? ` inside '${parentId}'` : ''
  const nested = children(el, 'tasks').flatMap((t) => children(t, 'task')).map((t) => attr(t, 'id') || attr(t, 'operation'))
  return new Error(
    `Recipe '${ctx.recipeId}': ${id ? `task '${id}'` : 'an unnamed task'} is a legacy ${form}${where}` +
      (nested.length ? ` wrapping ${nested.join(', ')}` : '') +
      '; batches are not supported by format v2, migrate it to a unit stream (unit="…" on the outputs, see SCHEDULING.spec.md §10.1)'
  )
}

function parseTasks(el, ctx) {
  const tasks = []
  for (const c of children(el)) {
    if (c.nodeName === 'task') tasks.push(parseTask(c, ctx))
    else if (c.nodeName === 'join') tasks.push(parseJoin(c, ctx))
    else if (c.nodeName === 'batch') throw legacyBatchError(c, ctx, null)
    else throw new Error(`Unexpected <${c.nodeName}> in <tasks>`)
  }
  return tasks
}

// ---------------------------------------------------------------------------------------------------------------
// Recipe

function parseServing(el) {
  if (!el) return null
  const hold = numberAttr(el, 'hold')
  return {
    temperature: attr(el, 'temperature') || 'ambient',
    hold: hold === null ? null : toSeconds({ number: hold, unit: attr(el, 'hold-unit') || 'minutes' }),
  }
}

function parseIngredient(el) {
  const id = attr(el, 'id')
  if (!id) throw new Error('<ingredient> without an id')
  return { id, name: ownText(el) || id, properties: parseProperties(child(el, 'properties')) }
}

function parseToolDefinition(el) {
  const id = attr(el, 'id')
  if (!id) throw new Error('<tool> definition without an id')
  const properties = parseProperties(child(el, 'properties'))
  const cap = properties.capacity
  const capacity = cap && cap.number !== undefined && cap.number !== null
    ? { number: cap.number, unit: cap.unit === undefined ? null : cap.unit }
    : null
  return { id, name: ownText(el) || id, type: attr(el, 'type') || id, capacity, properties }
}

/**
 * Parse a recipe XML document into a RecipeModel (README §2).
 *
 * @param {string} xmlString the recipe XML (format v2)
 * @param {{ DOMParser: typeof DOMParser, id?: string }} options a DOMParser constructor (browser or @xmldom/xmldom)
 *   and an optional recipe id used when the document carries no `id` attribute
 * @returns {object} RecipeModel
 */
export function parseRecipe(xmlString, { DOMParser, id } = {}) {
  if (typeof DOMParser !== 'function') throw new Error('parseRecipe needs a DOMParser constructor')
  const doc = new DOMParser().parseFromString(String(xmlString), 'text/xml')
  const root = doc && doc.documentElement
  if (!root) throw new Error('Recipe XML could not be parsed')
  if (root.nodeName === 'parsererror') throw new Error(`Recipe XML could not be parsed: ${collapse(root.textContent)}`)
  if (root.nodeName !== 'recipe') throw new Error(`Expected a <recipe> document, got <${root.nodeName}>`)
  const errors = root.getElementsByTagName('parsererror')
  if (errors.length > 0) throw new Error(`Recipe XML could not be parsed: ${collapse(errors[0].textContent)}`)

  const titleEl = child(root, 'title')
  const title = titleEl ? collapse(titleEl.textContent) : ''
  const recipeId = attr(root, 'id') || id || kebab(title)
  if (!recipeId) throw new Error('Recipe has no id and no title to derive one from')

  let index = 0
  const ctx = { recipeId, nextIndex: () => ++index }

  const ingredientsEl = child(root, 'ingredients')
  const toolsEl = child(root, 'tools')
  const tasksEl = child(root, 'tasks')

  return {
    id: recipeId,
    title,
    ref: attr(root, 'ref'),
    serving: parseServing(child(root, 'serving')),
    ingredients: ingredientsEl ? children(ingredientsEl, 'ingredient').map(parseIngredient) : [],
    tools: toolsEl ? children(toolsEl, 'tool').map(parseToolDefinition) : [],
    tasks: tasksEl ? parseTasks(tasksEl, ctx) : [],
  }
}
