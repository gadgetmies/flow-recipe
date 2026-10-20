// Ingredient name → density entry. Names are normalised (accents, punctuation, hyphens, plurals), leading
// quantities and units are dropped ("2 cups all-purpose flour, sifted"), and the longest alias that occurs as a
// contiguous run of words wins; ties go to the alias that ends later (the head noun: "orange bitters" → bitters,
// "cinnamon plum quark" → quark), then to the longer alias.

import { DENSITIES } from './densities.js'

const UNIT_WORDS = new Set([
  'cup', 'cups', 'c', 'tsp', 'tsps', 'teaspoon', 'teaspoons', 'tbsp', 'tbsps', 'tbs', 'tbl', 'tablespoon', 'tablespoons',
  'oz', 'ounce', 'ounces', 'fl', 'fluid', 'lb', 'lbs', 'pound', 'pounds', 'g', 'gram', 'grams', 'kg', 'kilogram',
  'kilograms', 'mg', 'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'cl', 'dl', 'l', 'liter', 'liters',
  'litre', 'litres', 'pint', 'pints', 'pt', 'quart', 'quarts', 'qt', 'gallon', 'gallons', 'gal', 'pinch', 'pinches',
  'dash', 'dashes', 'handful', 'handfuls', 'can', 'cans', 'tin', 'tins', 'jar', 'jars', 'package', 'packages', 'pkg',
  'packet', 'packets', 'envelope', 'envelopes', 'stick', 'sticks', 'piece', 'pieces', 'pcs', 'pc', 'bunch', 'bunches',
  'sprig', 'sprigs', 'heaping', 'heaped', 'level', 'scant', 'generous', 'rounded', 'about', 'approx', 'approximately',
  'small', 'medium', 'large', 'x', 'of', 'a', 'an', 'to', 'or', 'and', 'plus', 'tl', 'rkl', 'ruokalusikallinen', 'teelusikallinen',
])

/** Properties whose values describe the ingredient itself (not storage etc.) and help the match. */
const DESCRIPTIVE_PROPERTIES = ['type', 'kind', 'variety', 'brand', 'form', 'cut', 'state', 'style', 'grind']

function stem(word) {
  let w = word
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  if (w.length > 3 && w.endsWith('ie')) w = `${w.slice(0, -2)}y`
  else if (w.length > 3 && w.endsWith('oe')) w = w.slice(0, -1)
  else if (w.length > 4 && /(ch|sh|x|ss)e$/.test(w)) w = w.slice(0, -1)
  return w
}

/** Lower-case, accent-free, punctuation-free words; hyphens and slashes split words. */
export function normaliseIngredientName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9%.\s/-]+/g, ' ')
    .replace(/[-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(text) {
  return normaliseIngredientName(text).replace(/\./g, ' ').split(' ').filter(Boolean).map(stem)
}

/** Drops leading amounts and units: "2 1/2 cups (300 g) of flour" → "flour". */
function stripQuantity(text) {
  const words = normaliseIngredientName(text).replace(/\./g, ' ').split(' ').filter(Boolean)
  let i = 0
  while (i < words.length && (/^[0-9][0-9%]*$|^[0-9]*[.,]?[0-9]+$/.test(words[i]) || /^[0-9]+(g|kg|ml|l|dl|oz|lb)$/.test(words[i]) || UNIT_WORDS.has(words[i]))) i++
  return words.slice(i).join(' ')
}

let INDEX = null
function index() {
  if (INDEX) return INDEX
  INDEX = []
  for (const entry of DENSITIES) {
    for (const name of [...entry.names, entry.id.replace(/-/g, ' ')]) {
      const t = tokens(name)
      if (t.length > 0) INDEX.push({ tokens: t, length: t.join(' ').length, entry })
    }
  }
  return INDEX
}

function bestMatch(words) {
  if (words.length === 0) return null
  let best = null
  for (const alias of index()) {
    const n = alias.tokens.length
    for (let i = 0; i + n <= words.length; i++) {
      let ok = true
      for (let j = 0; j < n; j++) if (words[i + j] !== alias.tokens[j]) { ok = false; break }
      if (!ok) continue
      const score = [n, i + n, alias.length]
      if (!best || compare(score, best.score) > 0) best = { score, entry: alias.entry }
    }
  }
  return best
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

function propertyWords(properties) {
  if (!properties || typeof properties !== 'object') return ''
  const out = []
  for (const name of DESCRIPTIVE_PROPERTIES) {
    const p = properties[name]
    if (p === undefined || p === null) continue
    const v = typeof p === 'object' ? p.value : p
    if (typeof v === 'string' && v.trim()) out.push(v)
  }
  return out.join(' ')
}

/**
 * Density entry for an ingredient name, or null. Tolerates quantities, units, adjectives, plurals and preparation
 * notes ("2 cups all-purpose flour, sifted", "packed light brown sugar", "unsalted butter, softened"). Descriptive
 * properties (type, kind, variety, brand, form …) are prepended, so `cinnamon` with `type=ground` matches
 * "ground cinnamon". An entry id ("flour-all-purpose") also matches.
 *
 * @param {string} ingredientName
 * @param {object} [properties] RecipeModel ingredient properties ({ name: { value } }) or a plain { name: value }
 * @returns {object|null} DENSITIES entry
 */
export function findDensity(ingredientName, properties) {
  if (ingredientName === null || ingredientName === undefined) return null
  const raw = String(ingredientName)
  const byId = DENSITIES.find((e) => e.id === raw.trim().toLowerCase())
  if (byId) return byId

  const extra = propertyWords(properties)
  const cleaned = raw.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
  const [head, ...rest] = cleaned.split(/[,;:]/)
  // Main part first (alternatives in order: "butter or margarine" → butter), then the trailing notes.
  const alternatives = head.split(/\s+or\s+|\s*\/\s*/i)
  for (const alt of alternatives) {
    const words = tokens(`${extra} ${stripQuantity(alt)}`)
    const m = bestMatch(words)
    if (m) return m.entry
  }
  const whole = bestMatch(tokens(`${extra} ${stripQuantity(head)}`))
  if (whole) return whole.entry
  const tail = bestMatch(tokens(rest.join(' ')))
  return tail ? tail.entry : null
}

/** All entries whose aliases occur in the name, best first (for lookups that want alternatives). */
export function findDensities(ingredientName, properties) {
  const words = tokens(`${propertyWords(properties)} ${stripQuantity(String(ingredientName || '').replace(/\([^)]*\)/g, ' '))}`)
  const seen = new Map()
  for (const alias of index()) {
    const n = alias.tokens.length
    for (let i = 0; i + n <= words.length; i++) {
      if (alias.tokens.every((t, j) => words[i + j] === t)) {
        const score = [n, i + n, alias.length]
        const prev = seen.get(alias.entry.id)
        if (!prev || compare(score, prev.score) > 0) seen.set(alias.entry.id, { score, entry: alias.entry })
      }
    }
  }
  return [...seen.values()].sort((a, b) => compare(b.score, a.score)).map((m) => m.entry)
}
