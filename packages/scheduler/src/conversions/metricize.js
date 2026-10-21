// Rewrites a recipe XML document to metric units in place (README "Conversions").
//
// Browser-safe: takes the DOMParser / XMLSerializer constructors (browser globals or @xmldom/xmldom) and uses only
// DOM Level 2 calls (getElementsByTagName, childNodes, get/set/hasAttribute, createComment, insertBefore).

import { canonicalUnit, isImperialLength, isImperialMass, isImperialVolume, toMetricBase } from '../units.js'
import { formatAmount, inchesToCm, tidy, toCelsiusRounded, toMetricAmount } from './convert.js'

const ELEMENT_NODE = 1
const TEXT_NODE = 3

/** Tool / ingredient properties whose numeric lengths are converted to cm. */
const LENGTH_PROPERTIES = new Set(['size', 'diameter', 'length', 'width', 'height', 'depth', 'circumference', 'capacity', 'thickness'])

function attr(el, name) {
  return el.hasAttribute(name) ? el.getAttribute(name) : null
}

function children(el, name) {
  const out = []
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i]
    if (n.nodeType === ELEMENT_NODE && (name === undefined || n.nodeName === name)) out.push(n)
  }
  return out
}

function child(el, name) {
  return children(el, name)[0] || null
}

function ownText(el) {
  let s = ''
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i]
    if (n.nodeType === TEXT_NODE || n.nodeType === 4) s += n.textContent
  }
  return s.replace(/\s+/g, ' ').trim()
}

function propertiesOf(el) {
  const props = {}
  const container = child(el, 'properties')
  if (!container) return props
  for (const p of children(container, 'property')) {
    const name = attr(p, 'name')
    if (name && attr(p, 'value') !== null) props[name] = { value: attr(p, 'value') }
  }
  return props
}

/** XML comments may not contain "--" or end with "-". */
function commentText(s) {
  return ` ${String(s).replace(/-{2,}/g, '–').replace(/-$/, '– ')} `
}

/** Inserts `<!-- text -->` before `el`, repeating the indentation that precedes it so the layout stays tidy. */
function annotate(doc, el, text) {
  const parent = el.parentNode
  const comment = doc.createComment(commentText(text))
  const prev = el.previousSibling
  parent.insertBefore(comment, el)
  if (prev && prev.nodeType === TEXT_NODE && /^\s+$/.test(prev.nodeValue) && /\n/.test(prev.nodeValue)) {
    parent.insertBefore(doc.createTextNode(prev.nodeValue.slice(prev.nodeValue.lastIndexOf('\n'))), el)
  }
}

function setNumber(el, numberAttr, unitAttr, to) {
  el.setAttribute(numberAttr, String(tidy(to.number)))
  if (to.unit !== null && to.unit !== undefined) el.setAttribute(unitAttr, to.unit)
}

function parse(xml, DOMParser) {
  const errors = []
  const handler = { warning() {}, error: (m) => errors.push(String(m)), fatalError: (m) => errors.push(String(m)) }
  // The browser DOMParser ignores constructor arguments; @xmldom/xmldom uses the error handler.
  const doc = new DOMParser({ errorHandler: handler, onError: (level, m) => level !== 'warning' && errors.push(String(m)) }).parseFromString(String(xml), 'text/xml')
  const root = doc && doc.documentElement
  if (!root || root.nodeName === 'parsererror' || root.getElementsByTagName('parsererror').length > 0) {
    const msg = root ? root.textContent : 'no document element'
    throw new Error(`Recipe XML could not be parsed: ${String(msg).replace(/\s+/g, ' ').trim()}`)
  }
  if (errors.length > 0) throw new Error(`Recipe XML could not be parsed: ${errors[0]}`)
  return doc
}

const PROLOG = /^﻿?\s*<\?xml[^?]*\?>/

/** Serialises, keeping the original XML declaration and trailing newline. */
function serialise(doc, XMLSerializer, original) {
  let out = new XMLSerializer().serializeToString(doc)
  const prolog = original.match(PROLOG)
  if (prolog) {
    if (PROLOG.test(out)) out = out.replace(PROLOG, prolog[0])
    else out = `${prolog[0]}\n${out}`
  }
  const trailing = original.match(/\s*$/)[0]
  return out.replace(/\s*$/, '') + trailing
}

/**
 * Converts a recipe document to metric units: `amount` options (via the ingredient's density), Fahrenheit
 * temperatures, imperial masses / volumes / lengths in any numeric-value, output volumes, and inch sizes in property
 * values ("9x13 inch"). Every changed value gets an XML comment `<!-- converted from … -->` in front of it.
 * Idempotent; when nothing changes the input string is returned as is.
 *
 * @param {string} xml recipe XML (format v2)
 * @param {{ DOMParser: Function, XMLSerializer: Function, precisionScale?: boolean }} options
 * @returns {{ xml: string, changes: object[], warnings: string[] }}
 */
export function metricizeRecipeXml(xml, { DOMParser, XMLSerializer, precisionScale = false } = {}) {
  if (typeof DOMParser !== 'function') throw new Error('metricizeRecipeXml needs a DOMParser constructor')
  if (typeof XMLSerializer !== 'function') throw new Error('metricizeRecipeXml needs an XMLSerializer constructor')
  const source = String(xml)
  const doc = parse(source, DOMParser)
  const root = doc.documentElement
  const changes = []
  const warnings = []

  // Ingredients and outputs by id, for resolving what a measure task measures.
  const ingredients = new Map()
  const ingredientsEl = child(root, 'ingredients')
  for (const el of ingredientsEl ? children(ingredientsEl, 'ingredient') : []) {
    const id = attr(el, 'id')
    if (id) ingredients.set(id, { id, name: ownText(el) || id, properties: propertiesOf(el) })
  }
  const outputs = new Map()
  for (const el of Array.from(root.getElementsByTagName('output'))) {
    const id = attr(el, 'id')
    if (id && !outputs.has(id)) outputs.set(id, { id, name: ownText(el) || id })
  }

  const handled = new Set()

  // 1. amount options of tasks, converted with the measured ingredient's density.
  for (const task of Array.from(root.getElementsByTagName('task'))) {
    const taskId = attr(task, 'id') || attr(task, 'operation') || null
    const refs = Array.from(task.getElementsByTagName('input')).map((i) => attr(i, 'ref')).filter(Boolean)
    const ingredientRef = refs.find((r) => ingredients.has(r)) || null
    const outputRef = ingredientRef ? null : refs.find((r) => outputs.has(r)) || null
    const ingredient = ingredientRef ? ingredients.get(ingredientRef) : outputRef ? { id: outputRef, name: outputs.get(outputRef).name, properties: {} } : null

    for (const option of Array.from(task.getElementsByTagName('option'))) {
      if (attr(option, 'name') !== 'amount') continue
      const nv = child(option, 'numeric-value')
      if (!nv || handled.has(nv)) continue
      handled.add(nv)
      const number = Number(attr(nv, 'number'))
      const unit = attr(nv, 'unit')
      if (attr(nv, 'number') === null || !Number.isFinite(number)) continue
      const r = toMetricAmount({ number, unit }, { ingredient: ingredient ? ingredient.name : null, properties: ingredient ? ingredient.properties : undefined, precisionScale })
      if (r.note && /unknown unit/.test(r.note)) warnings.push(`Task '${taskId}': ${r.note} in amount, left as is`)
      if (r.number === number && (r.unit || null) === (unit || null)) continue
      if (r.note === 'no density known' || (r.note && r.note.startsWith('no density known'))) {
        warnings.push(`Task '${taskId}': no density known for '${ingredient ? ingredient.name : 'unknown ingredient'}', ${formatAmount(r.from)} kept as volume (${formatAmount(r)})`)
      }
      setNumber(nv, 'number', 'unit', r)
      const what = ingredient ? ingredient.name : null
      const detail = r.method === 'density' && r.density ? `${what}, ${r.density.gPerMl} g/ml` : what
      annotate(doc, nv, `converted from ${formatAmount(r.from)}${detail ? ` (${detail})` : ''}`)
      changes.push({ taskId, ingredientId: ingredient ? ingredient.id : null, from: r.from, to: { number: r.number, unit: r.unit }, method: r.method, note: r.note })
    }
  }

  // 2. Every other numeric-value: Fahrenheit → °C, imperial mass / volume → g / ml, inches → cm.
  for (const nv of Array.from(root.getElementsByTagName('numeric-value'))) {
    if (handled.has(nv)) continue
    const unit = attr(nv, 'unit')
    const raw = attr(nv, 'number')
    if (!unit || raw === null || !Number.isFinite(Number(raw))) continue
    const number = Number(raw)
    const owner = nv.parentNode
    const ownerName = owner && owner.nodeType === ELEMENT_NODE ? attr(owner, 'name') : null
    const where = describe(owner)
    let to = null
    let method = 'metric'
    if (canonicalUnit(unit) === 'fahrenheit') {
      to = { number: toCelsiusRounded(number), unit: 'celsius' }
    } else if (isImperialLength(unit)) {
      to = { number: inchesToCm(number), unit: 'cm' }
    } else if (isImperialMass(unit)) {
      const g = toMetricBase({ number, unit }).number
      to = g >= 1000 ? { number: tidy(Math.round(g / 10) / 100), unit: 'kg' } : { number: g < 10 ? tidy(g) : Math.round(g), unit: 'g' }
    } else if (isImperialVolume(unit)) {
      const ml = toMetricBase({ number, unit }).number
      to = ownerName === 'capacity' || ml >= 1000 ? { number: tidy(Math.round(ml / 10) / 100), unit: 'l' } : { number: Math.round(ml), unit: 'ml' }
    }
    if (!to) continue
    setNumber(nv, 'number', 'unit', to)
    annotate(doc, nv, `converted from ${formatAmount({ number, unit })}`)
    changes.push({ taskId: where.taskId, ingredientId: where.ingredientId, from: { number, unit }, to, method, note: ownerName ? `${ownerName}` : null })
  }

  // 3. Output volumes (volume / volume-unit attributes) in US units → litres.
  for (const out of Array.from(root.getElementsByTagName('output'))) {
    const v = attr(out, 'volume')
    const vu = attr(out, 'volume-unit')
    if (v === null || !vu || !isImperialVolume(vu)) continue
    const number = Number(v)
    if (!Number.isFinite(number)) continue
    const ml = toMetricBase({ number, unit: vu }).number
    const to = { number: tidy(Math.round(ml / 10) / 100), unit: 'l' }
    out.setAttribute('volume', String(to.number))
    out.setAttribute('volume-unit', 'l')
    annotate(doc, out, `converted from volume ${formatAmount({ number, unit: vu })}`)
    changes.push({ taskId: describe(out).taskId, ingredientId: null, from: { number, unit: vu }, to, method: 'metric', note: `output '${attr(out, 'id')}' volume` })
  }

  // 4. Inch sizes in property values: value="9x13 inch", value="9 in".
  for (const prop of Array.from(root.getElementsByTagName('property'))) {
    const name = attr(prop, 'name')
    const value = attr(prop, 'value')
    if (!name || value === null || !LENGTH_PROPERTIES.has(name)) continue
    const converted = convertInchText(value)
    if (converted === null || converted === value) continue
    prop.setAttribute('value', converted)
    annotate(doc, prop, `converted from ${value}`)
    const where = describe(prop)
    changes.push({ taskId: where.taskId, ingredientId: where.ingredientId, from: { text: value }, to: { text: converted }, method: 'metric', note: name })
  }

  if (changes.length === 0) return { xml: source, changes, warnings }
  return { xml: serialise(doc, XMLSerializer, source), changes, warnings }
}

/** "9x13 inch" → "23x33 cm", "9-inch" → "23 cm"; null when the text has no inch measure. */
export function convertInchText(text) {
  const m = String(text).match(/^\s*([0-9]+(?:[.,][0-9]+)?)(?:\s*[x×]\s*([0-9]+(?:[.,][0-9]+)?))?(?:\s*[x×]\s*([0-9]+(?:[.,][0-9]+)?))?\s*-?\s*(in|inch|inches|")\.?\s*$/i)
  if (!m) return null
  const nums = [m[1], m[2], m[3]].filter(Boolean).map((s) => inchesToCm(Number(s.replace(',', '.'))))
  return `${nums.join('x')} cm`
}

/** Nearest task id and ingredient id above a node. */
function describe(node) {
  let taskId = null
  let ingredientId = null
  for (let n = node; n && n.nodeType === ELEMENT_NODE; n = n.parentNode) {
    if (!taskId && (n.nodeName === 'task' || n.nodeName === 'join')) taskId = attr(n, 'id')
    if (!ingredientId && (n.nodeName === 'ingredient' || (n.nodeName === 'tool' && attr(n, 'id')))) ingredientId = attr(n, 'id')
  }
  return { taskId, ingredientId }
}

