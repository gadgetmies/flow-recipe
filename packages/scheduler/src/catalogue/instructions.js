// Instruction text for a task (README §3), ported from the client's operations.js `instruction` functions to the
// RecipeModel. Never throws on missing names: an unresolved ref renders as its id.

import { isMass, isVolume, isTime, isCount, normaliseAmount, canonicalUnit } from '../units.js'

/**
 * Human-readable amount with unit: mass/volume normalised ("250 g", "0.5 l"), time with singular/plural
 * ("1 hour", "20 minutes"), temperature as "30 °C", percent as "200 %", counts without a unit ("1").
 *
 * @param {{ number?: number, unit?: string, text?: string }} value option or amount
 * @returns {string}
 */
export function formatAmount(value) {
  if (!value) return ''
  if (value.number === undefined || value.number === null) return value.text !== undefined ? String(value.text) : ''
  const number = Number(value.number)
  const unit = value.unit ? String(value.unit) : ''
  if (!unit) return `${number}`
  if (isMass(unit) || isVolume(unit)) {
    const n = normaliseAmount({ number, unit })
    return `${n.number} ${n.unit}`
  }
  if (isTime(unit)) {
    const c = canonicalUnit(unit)
    return `${number} ${number === 1 ? c.replace(/s$/, '') : c}`
  }
  if (isCount(unit)) return `${number}`
  const c = canonicalUnit(unit)
  if (c === 'celsius') return `${number} °C`
  if (c === 'fahrenheit') return `${number} °F`
  if (c === 'percent') return `${number} %`
  return `${number} ${unit}`
}

function collectNames(recipe) {
  const names = new Map()
  const add = (id, name) => {
    if (id && !names.has(id)) names.set(id, name || null)
  }
  const addTask = (task) => {
    for (const output of task.outputs || []) add(output.id, output.name)
    for (const tool of task.returnsTools || []) if (tool.name) add(tool.ref, tool.name)
    for (const tool of task.tools || []) if (tool.name) add(tool.ref, tool.name)
    for (const step of task.steps || []) addTask(step)
  }
  if (recipe) {
    for (const ingredient of recipe.ingredients || []) add(ingredient.id, ingredient.name)
    for (const tool of recipe.tools || []) add(tool.id, tool.name)
    for (const task of recipe.tasks || []) addTask(task)
  }
  return names
}

function tidy(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .trim()
}

function joinList(items) {
  const list = items.filter((s) => s !== null && s !== undefined && s !== '')
  if (list.length <= 1) return list.join('')
  return `${list.slice(0, -1).join(', ')} & ${list[list.length - 1]}`
}

class Context {
  constructor(task, recipe, catalogue) {
    this.task = task || {}
    this.recipe = recipe || {}
    this.catalogue = catalogue || {}
    this.names = collectNames(recipe)
    this.operation = this.catalogue[this.task.operation] || null
  }

  name(ref) {
    if (ref === undefined || ref === null) return ''
    return this.names.get(ref) || String(ref)
  }

  inputs() {
    return this.task.inputs || []
  }

  inputName(i) {
    const input = this.inputs()[i]
    return input ? this.name(input.ref) : ''
  }

  input(i) {
    const input = this.inputs()[i]
    if (!input) return ''
    const name = this.name(input.ref)
    return input.amount !== null && input.amount !== undefined ? `${input.amount} ${name}` : name
  }

  inputList() {
    return this.inputs().map((_, i) => this.input(i))
  }

  tool(i) {
    const tool = (this.task.tools || [])[i]
    return tool ? this.name(tool.ref) : ''
  }

  option(name) {
    const options = this.task.options || {}
    return options[name] || null
  }

  optionText(name) {
    const value = this.option(name)
    if (!value) return ''
    const declared = this.operation && this.operation.options && this.operation.options[name]
    const unit = value.unit || (declared && declared.defaultUnit) || undefined
    return formatAmount(unit ? { ...value, unit } : value)
  }

  optionNumber(name) {
    const value = this.option(name)
    return value && value.number !== undefined && value.number !== null ? `${value.number}` : ''
  }

  title() {
    return (this.operation && this.operation.title) || this.task.operation || ''
  }
}

const or = (...candidates) => candidates.find((c) => c) || ''

// One function per operation; `c` is a Context. Order and wording follow operations.js.
const TEMPLATES = {
  measure: (c) => {
    const amount = c.optionText('amount')
    const what = `${amount ? `${amount} ` : ''}${c.inputName(0)}`
    const container = c.inputName(1)
    if (container) return `Measure ${what} into ${container}`
    const tool = c.tool(0)
    const second = c.tool(1)
    return `Measure ${what}${tool ? ` into ${tool}${second ? ` using ${second}` : ''}` : ''}`
  },
  heat: (c) =>
    c.option('temperature')
      ? `Heat ${c.input(0)} to ${c.optionText('temperature')}`
      : `Heat ${c.input(0)} for ${c.optionText('duration')}`,
  'preheat-oven': (c) => `Set the oven to ${c.optionText('temperature')}`,
  crumble: (c) => `Crumble ${c.input(0)}`,
  mix: (c) => {
    const tool = c.tool(0)
    const second = c.tool(1)
    return `Mix ${joinList(c.inputList())}${tool ? ` with ${tool}${second ? ` in ${second}` : ''}` : ''}`
  },
  incorporate: (c) => {
    const [first, ...rest] = c.inputList()
    if (rest.length === 0) return `Mix ${first}`
    return `Incorporate ${joinList(rest)} into ${first}`
  },
  'mix-in-steps': (c) => `Mix ${c.input(1)} to ${c.input(0)} in steps`,
  wait: (c) => `Wait for ${c.optionText('duration')}`,
  raise: (c) => `Raise ${c.inputName(0)} for ${c.optionText('duration')}`,
  batch: () => 'Process in batches',
  fill: (c) => `Fill ${or(c.input(0), c.tool(0))}`,
  pour: (c) => `Pour ${c.input(0)} into ${or(c.tool(0), c.input(1))}`,
  strain: (c) => `Strain ${c.inputName(0)} into ${or(c.tool(1), c.tool(0), c.input(1))}`,
  express: (c) => `Express oils from ${c.input(0)} over ${or(c.input(1), c.tool(0))}`,
  spherify: (c) => `Roll ${c.input(0)} into balls`,
  separate: (c) => `Separate ${c.inputName(0)}`,
  grease: (c) => `Grease ${c.tool(0)} with ${c.inputName(0)}`,
  stir: (c) => `Stir ${c.input(0)}${c.tool(0) ? ` with ${c.tool(0)}` : ''}`,
  muddle: (c) => `Muddle ${c.input(0)}${c.tool(0) ? ` with ${c.tool(0)}` : ''}`,
  peel: (c) => `Peel ${c.input(0)}${c.tool(0) ? ` with ${c.tool(0)}` : ''}`,
  soften: (c) => `Soften ${c.input(0)}${c.tool(0) ? ` with ${c.tool(0)}` : ''}`,
  ball: (c) => `Carve out balls from ${c.input(0)}${c.tool(0) ? ` with ${c.tool(0)}` : ''}`,
  enjoy: (c) => `Enjoy the ${c.input(0)}!`,
  decorate: (c) => `Decorate ${c.input(0)} with ${c.input(1)}`,
  cream: (c) => `Cream ${c.input(0)} and ${c.input(1)}${c.tool(0) ? ` with ${c.tool(0)}` : ''}`,
  stack: (c) => `Stack ${c.input(0)} on top of ${c.input(1)}`,
  'bake-in-microwave': (c) =>
    c.option('power')
      ? `Bake ${c.input(0)} with ${c.optionText('power')} in the microwave oven for ${c.optionText('duration')}`
      : `Bake ${c.input(0)} for ${c.optionText('duration')} in the microwave oven`,
  place: (c) => `Place ${c.input(0)} into ${or(c.tool(0), c.input(1))}`,
  split: (c) => {
    const parts = c.optionNumber('parts')
    if (parts) return `Split ${c.input(0)} into ${parts} parts`
    const size = c.optionText('unit-size')
    return size ? `Split ${c.input(0)} into pieces of ${size}` : `Split ${c.input(0)}`
  },
  'bake-in-oven': (c) =>
    `Bake ${c.input(0)} at ${c.optionText('temperature')}${c.option('duration') ? ` for ${c.optionText('duration')}` : ''}`,
  'put-into-oven': (c) => `Put ${c.input(0)} into oven`,
  'take-out-of-oven': (c) => `Take ${c.input(0)} out of oven`,
  brush: (c) => `Brush ${c.input(0)} with ${c.input(1)}`,
  sprinkle: (c) => `Sprinkle ${c.input(0)} on ${c.input(1)}`,
  dust: (c) => `Dust ${c.input(0)} with ${c.input(1)}${c.tool(0) ? ` using ${c.tool(0)}` : ''}`,
  slice: (c) => {
    const parts = c.optionNumber('parts')
    return `Slice ${c.input(0)}${parts ? ` into ${parts} parts` : ''}${c.tool(0) ? ` with ${c.tool(0)}` : ''}`
  },
  grate: (c) => `Grate ${c.input(0)}`,
  spread: (c) => `Spread ${c.input(0)} onto ${c.input(1)}`,
  transfer: (c) => `Transfer ${c.input(0)} onto ${or(c.tool(1), c.tool(0), c.input(1))}`,
  beat: (c) => `Beat ${c.input(0)}`,
  'place-on-sheet': (c) => `Place ${c.input(0)} on a sheet`,
  chill: (c) => `Chill ${c.input(0)} for ${c.optionText('duration')}`,
  spoon: (c) => `Spoon ${c.input(1)} on ${c.input(0)}`,
  cover: (c) => `Cover ${c.input(1)} with ${c.input(0)}`,
  level: (c) => `Level ${c.input(0)}`,
  'add-on-top': (c) => `Add ${c.input(1)} on top of ${c.input(0)}`,
  press: (c) => `Press ${c.input(1)} into ${c.input(0)}`,
  line: (c) => {
    if (c.inputs().length >= 2) return `Line ${c.input(0)} with ${c.input(1)}`
    const target = or(c.tool(0), c.input(0))
    const material = c.tool(0) ? c.input(0) : c.tool(1)
    return material ? `Line ${target} with ${material}` : `Line ${target}`
  },
  melt: (c) => `Melt ${c.inputName(0)}`,
  fold: (c) => `Fold ${c.inputName(1)} into ${c.inputName(0)}`,
  boil: (c) => `Boil ${c.input(0)}`,
  soak: (c) =>
    `Soak ${c.input(0)}${c.input(1) ? ` in ${c.input(1)}` : ''}${c.option('duration') ? ` for ${c.optionText('duration')}` : ''}`,
  whip: (c) => `Whip ${c.input(0)}`,
  clean: (c) => {
    const tools = (c.task.tools || []).map((t) => c.name(t.ref)).filter(Boolean)
    return tools.length ? `Wash up ${joinList(tools)}` : 'Wash up'
  },
  serve: (c) => {
    const list = joinList(c.inputList())
    return list ? `Serve ${list}` : 'Serve'
  },
}

function renderInstructions(c, items) {
  const pieces = items.map((item) => {
    if (!item) return ''
    if (item.text !== undefined) return String(item.text)
    if (item.input !== undefined) {
      const name = c.name(item.input)
      return item.amount !== undefined && item.amount !== null ? `${item.amount} ${name}` : name
    }
    if (item.tool !== undefined) return c.name(item.tool)
    if (item.output !== undefined) return c.name(item.output)
    if (item.option !== undefined) return c.optionText(item.option) || String(item.option)
    return ''
  })
  return tidy(pieces.join(' '))
}

function generic(c) {
  const list = joinList(c.inputList())
  return list ? `${c.title()} ${list}` : c.title()
}

function textFor(task, recipe, catalogue) {
  const c = new Context(task, recipe, catalogue)
  if (Array.isArray(task.instructions) && task.instructions.length > 0) return renderInstructions(c, task.instructions)
  if (task.operation === 'join' && Array.isArray(task.steps)) {
    return task.steps
      .map((step) => textFor(step, recipe, catalogue))
      .filter(Boolean)
      .map((s) => s.replace(/[.!]\s*$/, ''))
      .join('. ')
  }
  const template = TEMPLATES[task.operation]
  let text
  try {
    text = template ? template(c) : generic(c)
  } catch (e) {
    text = generic(c)
  }
  return tidy(text)
}

/**
 * Plain-text instruction for a task. Uses the task's `<instructions>` mixed content when present, otherwise the
 * per-operation template ported from operations.js; a `join` concatenates its steps with ". ".
 *
 * @param {object} task RecipeModel Task
 * @param {object} recipe RecipeModel (for names of ingredients, tools and outputs)
 * @param {object} catalogue Catalogue (for titles and option default units)
 * @param {{ units?: number, batch?: { index: number, of: number } | null }} [extra] batch suffix ("sheet 2 of 4")
 * @returns {string}
 */
export function instructionText(task, recipe, catalogue, { units, batch } = {}) {
  if (!task) return ''
  let text = textFor(task, recipe || {}, catalogue || {})
  if (batch && batch.of > 1) text = `${text} (batch ${batch.index} of ${batch.of})`
  return text
}
