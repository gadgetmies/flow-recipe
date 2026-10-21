// Recipe source extraction: fetch a page safely (http/https only, SSRF guard pinned at connect time — see net.js,
// timeout, size limit) and turn it into
// a Source — schema.org Recipe JSON-LD first (incl. @graph, arrays, HowToSection), then microdata, then the
// readable main text.

import { SourceError, assertPublicUrl, createGuardedFetch } from './net.js'
import { collapse, decodeEntities, findAll, findFirst, htmlToText, metaContent, parseHtml, rawText, readableText, tidyText } from './html.js'

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
/** The honest identity used for the one retry after a 403 (some bot filters only block clients claiming to be browsers). */
export const IMPORTER_USER_AGENT = 'flow-recipe-importer/1.0 (recipe import for a kitchen planner)'

/** Request headers of a current desktop Chrome opening a page from the address bar. */
export const BROWSER_HEADERS = Object.freeze({
  'user-agent': USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9,fi;q=0.8,sv;q=0.7,de;q=0.6',
  'accept-encoding': 'gzip, deflate, br',
  'cache-control': 'max-age=0',
  'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
})

/** Headers for the retry after a 403: plain, honest, no browser claims. */
export const PLAIN_HEADERS = Object.freeze({
  'user-agent': IMPORTER_USER_AGENT,
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
})

export const MAX_TEXT_CHARS = 30000

export { SourceError, isPrivateAddress, assertPublicUrl, createGuardedFetch, parseIPv6 } from './net.js'

// ---------------------------------------------------------------------------------------------------------------
// Fetch

function contentTypeOf(res) {
  const h = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : null
  return String(h || '').toLowerCase()
}

function charsetOf(contentType, bytes) {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || '')
  if (m) return m[1]
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1')
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)
  return meta ? meta[1] : 'utf-8'
}

function decodeBytes(bytes, charset) {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

async function readBody(res, maxBytes) {
  const declared = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN)
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = new Uint8Array(await res.arrayBuffer())
    return { bytes: buf.subarray(0, maxBytes), truncated: buf.length > maxBytes }
  }
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  let truncated = Number.isFinite(declared) && declared > maxBytes
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
    if (size >= maxBytes) {
      truncated = true
      try {
        await reader.cancel()
      } catch {
        // ignore
      }
      break
    }
  }
  const all = new Uint8Array(Math.min(size, maxBytes))
  let off = 0
  for (const c of chunks) {
    const take = Math.min(c.length, all.length - off)
    if (take <= 0) break
    all.set(c.subarray(0, take), off)
    off += take
  }
  return { bytes: all, truncated }
}

function combineSignals(signals) {
  const list = signals.filter(Boolean)
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  const ctl = new AbortController()
  for (const s of list) {
    if (s.aborted) ctl.abort(s.reason)
    else s.addEventListener('abort', () => ctl.abort(s.reason), { once: true })
  }
  return ctl.signal
}

async function discardBody(res) {
  try {
    if (res.body && typeof res.body.cancel === 'function') await res.body.cancel()
  } catch {
    // ignore
  }
}

/**
 * Fetch a recipe page and extract its Source. Sends the headers of a desktop Chrome (retried once with plain
 * headers after a 403), follows up to 5 redirects (each hop
 * checked by the SSRF guard), times out after `timeoutMs` (whole download), reads at most `maxBytes` (the rest is
 * ignored; `source.truncated` is set). The default fetch is the guarded one from net.js, which re-checks every DNS
 * answer at connect time; a custom `fetch` (tests) only gets the per-hop URL check.
 * @returns {Promise<object>} Source
 */
export async function fetchRecipeSource(url, { fetch, timeoutMs = 15000, maxBytes = 3e6, signal, lookup, allowPrivate } = {}) {
  if (!fetch) fetch = createGuardedFetch(allowPrivate === undefined ? {} : { allowPrivate })
  if (typeof fetch !== 'function') throw new SourceError('network', 'No fetch implementation available (Node 18+ required)')
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = combineSignals([timeout, signal])
  const start = (await assertPublicUrl(url, { lookup, allowPrivate })).toString()
  let current = start
  let res
  try {
    // A browser-like request first; when the site answers 403 (bot filters that fingerprint the client and dislike
    // a "browser" that is not one), one retry with plain, honest headers.
    for (const headers of [BROWSER_HEADERS, PLAIN_HEADERS]) {
      current = start
      for (let hop = 0; ; hop++) {
        res = await fetch(current, { method: 'GET', redirect: 'manual', signal: combined, headers: { ...headers } })
        const location = res.status >= 300 && res.status < 400 && res.headers && res.headers.get ? res.headers.get('location') : null
        if (!location) break
        if (hop >= 5) throw new SourceError('http-status', `Too many redirects fetching ${url}`)
        const next = new URL(location, current).toString()
        await discardBody(res)
        current = (await assertPublicUrl(next, { lookup, allowPrivate })).toString()
      }
      if (res.status !== 403 || headers === PLAIN_HEADERS) break
      await discardBody(res)
    }
    if (!res.ok) {
      const hint = res.status === 403 || res.status === 429 || res.status === 402 ? ' (the site blocks automated requests; paste the recipe text instead)' : ''
      throw new SourceError('http-status', `The page returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${hint}`, { status: res.status })
    }
    const type = contentTypeOf(res)
    const { bytes, truncated } = await readBody(res, maxBytes)
    const text = decodeBytes(bytes, charsetOf(type, bytes))
    const looksHtml = /<(!doctype html|html|head|body|script|div|meta)\b/i.test(text.slice(0, 5000))
    let source
    if (type.includes('html') || type.includes('xml') || (!type && looksHtml) || (type.startsWith('text/plain') && looksHtml)) {
      source = extractRecipeSource(text, current)
    } else if (type.startsWith('text/plain') || type.startsWith('text/markdown')) {
      source = textSource(text, { url: current })
    } else if (type.includes('json')) {
      source = extractRecipeSource(`<script type="application/ld+json">${text}</script>`, current)
    } else {
      throw new SourceError('not-html', `The URL is not a web page (content type ${type || 'unknown'})`)
    }
    if (truncated) source.truncated = true
    return source
  } catch (e) {
    if (e instanceof SourceError) throw e
    if (signal && signal.aborted) throw new SourceError('aborted', 'Import was cancelled')
    if (timeout.aborted || e.name === 'TimeoutError') throw new SourceError('timeout', `Fetching the page timed out after ${Math.round(timeoutMs / 1000)} s`)
    throw new SourceError('network', `Cannot fetch ${current}: ${e.cause && e.cause.code ? e.cause.code : e.message}`)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Value helpers

const MAX_DURATION_CHARS = 120
const ISO_UNIT_SECONDS = { Y: 365 * 86400, W: 7 * 86400, D: 86400, H: 3600, S: 1 }

/**
 * ISO 8601 duration → seconds with a linear scanner (no backtracking regex): P[nY][nM][nW][nD][T[nH][nM][nS]],
 * numbers may have a '.' or ',' fraction. null when the text is not such a duration.
 */
function parseIsoDuration(s) {
  let i = 0
  if (s[i] === '-' || s[i] === '+') i++
  if (s[i] !== 'P' && s[i] !== 'p') return null
  i++
  const dateOrder = 'YMWD'
  const timeOrder = 'HMS'
  let inTime = false
  let last = -1
  let total = 0
  let parts = 0
  let timeParts = 0
  while (i < s.length) {
    const c = s[i].toUpperCase()
    if (c === 'T') {
      if (inTime) return null
      inTime = true
      last = -1
      i++
      continue
    }
    const start = i
    while (i < s.length && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++
    if (i === start) return null
    if (s[i] === '.' || s[i] === ',') {
      i++
      const fracStart = i
      while (i < s.length && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++
      if (i === fracStart) return null
    }
    const value = Number(s.slice(start, i).replace(',', '.'))
    if (i >= s.length) return null
    const unit = s[i].toUpperCase()
    i++
    const order = inTime ? timeOrder : dateOrder
    const pos = order.indexOf(unit)
    if (pos < 0 || pos <= last) return null
    last = pos
    const factor = unit === 'M' ? (inTime ? 60 : 30 * 86400) : ISO_UNIT_SECONDS[unit]
    total += value * factor
    parts++
    if (inTime) timeParts++
  }
  if (!parts || (inTime && !timeParts)) return null
  return Math.round(total)
}

/** ISO 8601 duration (PT1H30M, P1DT2H, PT90M, P0DT0H45M0S) → seconds; also tolerates "1 hour 30 minutes". */
export function parseDuration(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return parseDuration(value[0])
  if (typeof value === 'object') return parseDuration(value['@value'] || value.value || null)
  const s = String(value).trim()
  // Durations are short; anything longer is not one (and must not reach a regex).
  if (!s || s.length > MAX_DURATION_CHARS) return null
  if (s[0] === 'P' || s[0] === 'p' || ((s[0] === '-' || s[0] === '+') && /^[-+][Pp]/.test(s))) {
    const iso = parseIsoDuration(s)
    if (iso !== null) return iso
  }
  let total = 0
  let found = false
  const re = /(\d{1,6}(?:[.,]\d{1,6})?)\s{0,3}(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b/gi
  let mm
  while ((mm = re.exec(s))) {
    found = true
    const v = Number(mm[1].replace(',', '.'))
    const u = mm[2].toLowerCase()
    total += u.startsWith('d') ? v * 86400 : u.startsWith('h') ? v * 3600 : u.startsWith('s') ? v : v * 60
  }
  return found ? Math.round(total) : null
}

function asArray(v) {
  if (v === null || v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

function typesOf(obj) {
  return asArray(obj && obj['@type']).map((t) => String(t).replace(/^.*[/#:]/, '').toLowerCase())
}

/** Plain text from a JSON-LD string value that may contain HTML and entities. */
function cleanText(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return cleanText(v['@value'] || v.text || v.name || '')
  const s = String(v)
  return /<[a-z][^<>]*>/i.test(s) ? tidyText(htmlToText(s)) : tidyText(decodeEntities(s).replace(/\r\n?/g, '\n'))
}

function cleanLine(v) {
  return collapse(cleanText(v))
}

const NUMBERING = /^\s*(?:step\s*)?\d{1,2}\s*[.):\-–]\s+|^\s*[-•*▢□☐✓]\s*/i

function stripNumbering(s) {
  return s.replace(NUMBERING, '').trim()
}

/** recipeInstructions (string | [string] | HowToStep | HowToSection | ItemList, nested) → [string] */
export function flattenInstructions(value, section = null) {
  const out = []
  const push = (text) => {
    const t = stripNumbering(collapse(text))
    if (t) out.push(section ? `[${section}] ${t}` : t)
  }
  for (const item of asArray(value)) {
    if (item === null || item === undefined) continue
    if (typeof item === 'string' || typeof item === 'number') {
      const text = cleanText(item)
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
      for (const l of lines) push(l)
      continue
    }
    if (typeof item !== 'object') continue
    const types = typesOf(item)
    if (types.includes('howtosection') || (item.itemListElement && !types.includes('howtostep'))) {
      const name = cleanLine(item.name) || section
      const inner = flattenInstructions(item.itemListElement || item.steps || [], name || null)
      if (inner.length === 0 && item.text) out.push(...flattenInstructions(item.text, name || null))
      else out.push(...inner)
      continue
    }
    if (types.includes('listitem') && item.item && typeof item.item === 'object') {
      out.push(...flattenInstructions(item.item, section))
      continue
    }
    const text = cleanText(item.text || item.description || item['@value'] || '')
    const name = cleanLine(item.name)
    if (text) {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
      const prefix = name && name.length <= 80 && !collapse(text).toLowerCase().startsWith(name.replace(/[.…]+$/, '').toLowerCase()) && !/^step\s*\d+$/i.test(name) ? `${name}: ` : ''
      lines.forEach((l, i) => push(i === 0 && prefix ? prefix + l : l))
    } else if (name) push(name)
  }
  return out
}

/** recipeYield → { yield: descriptive string | null, servings: number | null } */
export function parseYield(value) {
  const items = asArray(value).map((v) => (typeof v === 'number' ? String(v) : cleanLine(v))).filter(Boolean)
  if (!items.length) return { yield: null, servings: null }
  const descriptive = items.find((s) => /[a-z]/i.test(s)) || items[0]
  const servingLike = items.find((s) => /serv|people|person|portion|annos|henkil/i.test(s))
  const numberSource = servingLike || items.find((s) => /^\s*\d/.test(s)) || descriptive
  const m = /(\d+(?:[.,]\d+)?)/.exec(numberSource)
  const n = m ? Number(m[1].replace(',', '.')) : null
  return { yield: descriptive, servings: Number.isFinite(n) && n > 0 ? n : null }
}

// ---------------------------------------------------------------------------------------------------------------
// JSON-LD

function parseJsonLoose(text) {
  let s = String(text || '').trim()
  s = s.replace(/^<!--/, '').replace(/-->$/, '').replace(/^\s*\/\/\s*<!\[CDATA\[/, '').replace(/\/\/\s*\]\]>\s*$/, '').trim()
  s = s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim()
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    // Raw control characters inside strings (newlines, tabs) are common; replace them and drop trailing commas.
    try {
      return JSON.parse(s.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1'))
    } catch {
      return null
    }
  }
}

/** Every object with @type Recipe anywhere inside the JSON-LD value (handles @graph, arrays, mainEntity, …). */
export function findRecipeObjects(data, depth = 0, out = []) {
  if (!data || depth > 10) return out
  if (Array.isArray(data)) {
    for (const x of data) findRecipeObjects(x, depth + 1, out)
    return out
  }
  if (typeof data !== 'object') return out
  if (typesOf(data).includes('recipe')) {
    out.push(data)
    return out
  }
  for (const [k, v] of Object.entries(data)) {
    if (k === '@context') continue
    if (v && typeof v === 'object') findRecipeObjects(v, depth + 1, out)
  }
  return out
}

/** "0 kg kananmunaa" (a CMS placeholder for "some, for brushing") → "kananmunaa": a zero amount is no amount. */
function dropZeroAmount(line) {
  if (typeof line !== 'string') return line
  return line.replace(/^0+(?:[.,]0+)?\s+(?:[A-Za-zäöåÄÖÅ]{1,4}\.?\s+(?=\S))?/, '')
}

function recipeFromObject(obj) {
  const y = parseYield(obj.recipeYield !== undefined ? obj.recipeYield : obj.yield)
  const ingredients = asArray(obj.recipeIngredient || obj.ingredients)
    .flatMap((x) => (typeof x === 'object' && x !== null ? [x.name || x.text || ''] : [x]))
    .map(cleanLine)
    .map(dropZeroAmount)
    .filter(Boolean)
  const steps = flattenInstructions(obj.recipeInstructions || obj.instructions || [])
  const times = {}
  for (const [key, prop] of [['prep', 'prepTime'], ['cook', 'cookTime'], ['total', 'totalTime']]) {
    const s = parseDuration(obj[prop])
    if (s !== null && s > 0) times[key] = s
  }
  if (obj.performTime && times.cook === undefined) {
    const s = parseDuration(obj.performTime)
    if (s) times.cook = s
  }
  const extra = {}
  const description = cleanLine(obj.description)
  if (description) extra.description = description.slice(0, 1000)
  const category = asArray(obj.recipeCategory).map(cleanLine).filter(Boolean)
  const cuisine = asArray(obj.recipeCuisine).map(cleanLine).filter(Boolean)
  if (category.length) extra.category = category.join(', ')
  if (cuisine.length) extra.cuisine = cuisine.join(', ')
  const tools = asArray(obj.tool).map((t) => cleanLine(typeof t === 'object' && t ? t.name || t.text : t)).filter(Boolean)
  if (tools.length) extra.tools = tools
  return { title: cleanLine(obj.name || obj.headline) || null, ...y, ingredients, steps, times, ...extra }
}

function scoreRecipe(r) {
  return r.ingredients.length * 2 + r.steps.length + (r.title ? 1 : 0)
}

function jsonLdRecipe(root) {
  const scripts = findAll(root, (el) => el.name === 'script' && /ld\+json/i.test(el.attrs.type || ''))
  const recipes = []
  for (const s of scripts) {
    const data = parseJsonLoose(rawText(s))
    for (const obj of findRecipeObjects(data)) recipes.push(recipeFromObject(obj))
  }
  if (!recipes.length) return null
  recipes.sort((a, b) => scoreRecipe(b) - scoreRecipe(a))
  return recipes[0]
}

// ---------------------------------------------------------------------------------------------------------------
// Microdata

function itemValue(el) {
  if (el.attrs.itemscope !== undefined) return microdataItem(el)
  const a = el.attrs
  if (el.name === 'meta') return a.content || ''
  if (a.content !== undefined && a.content !== '') return a.content
  if (el.name === 'time' && a.datetime) return a.datetime
  if ((el.name === 'a' || el.name === 'link' || el.name === 'area') && a.href) return a.href
  if (['img', 'audio', 'video', 'source', 'embed', 'iframe'].includes(el.name) && a.src) return a.src
  if ((el.name === 'data' || el.name === 'meter') && a.value) return a.value
  return { __html: el }
}

function microdataItem(scope) {
  const item = { '@type': (scope.attrs.itemtype || '').split(/\s+/).filter(Boolean) }
  const visit = (el) => {
    for (const c of el.children || []) {
      if (c.type !== 'element') continue
      if (c.attrs.itemprop) {
        for (const name of c.attrs.itemprop.split(/\s+/).filter(Boolean)) {
          if (!item[name]) item[name] = []
          item[name].push(itemValue(c))
        }
        if (c.attrs.itemscope !== undefined) continue
      } else if (c.attrs.itemscope !== undefined) continue
      visit(c)
    }
  }
  visit(scope)
  return item
}

/** Microdata values: element values become their rendered text (lists split into lines for instructions). */
function mdText(v) {
  if (v && typeof v === 'object' && v.__html) return htmlToText(v.__html)
  if (v && typeof v === 'object') return mdText((v.text || v.name || [])[0])
  return cleanText(v)
}

function microdataRecipe(root) {
  const scopes = findAll(root, (el) => el.attrs.itemscope !== undefined && /schema\.org\/Recipe\b/i.test(el.attrs.itemtype || ''))
  if (!scopes.length) return null
  const item = microdataItem(scopes[0])
  const get = (k) => item[k] || []
  const ingredients = [...get('recipeIngredient'), ...get('ingredients')].flatMap((v) => mdText(v).split('\n')).map((s) => stripNumbering(collapse(s))).filter(Boolean)
  const steps = []
  for (const v of get('recipeInstructions')) {
    if (v && typeof v === 'object' && !v.__html) {
      const types = typesOf({ '@type': v['@type'] })
      if (types.includes('howtosection')) {
        const name = mdText((v.name || [])[0]).trim()
        for (const s of v.itemListElement || v.step || []) for (const l of mdText(s).split('\n')) if (stripNumbering(collapse(l))) steps.push(`${name ? `[${name}] ` : ''}${stripNumbering(collapse(l))}`)
        continue
      }
    }
    for (const l of mdText(v).split('\n')) {
      const t = stripNumbering(collapse(l))
      if (t) steps.push(t)
    }
  }
  const times = {}
  for (const [key, prop] of [['prep', 'prepTime'], ['cook', 'cookTime'], ['total', 'totalTime']]) {
    const s = parseDuration(mdText(get(prop)[0]))
    if (s) times[key] = s
  }
  const y = parseYield(get('recipeYield').map(mdText))
  const description = collapse(mdText(get('description')[0]))
  return {
    title: collapse(mdText(get('name')[0])) || null,
    ...y,
    ingredients,
    steps,
    times,
    ...(description ? { description: description.slice(0, 1000) } : {}),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Public API

function pageTitle(root) {
  const og = metaContent(root, 'og:title', 'twitter:title')
  if (og) return og
  const t = findFirst(root, (el) => el.name === 'title')
  const title = t ? collapse(decodeEntities(rawText(t).slice(0, 2000))).slice(0, 300) : ''
  if (title) return title.replace(/\s+[|–—-]\s+[^|–—-]{2,60}$/, '').trim() || title
  const h1 = findFirst(root, (el) => el.name === 'h1')
  return h1 ? collapse(htmlToText(h1)) : null
}

/**
 * Pure extraction of a Source from page HTML: JSON-LD Recipe (best-scoring one), else microdata, else only the
 * readable text. `text` is always filled (≤ 30 000 characters) so the LLM has a fallback.
 * @returns {object} Source = { url, title, yield, servings, ingredients, steps, times, text, structured, … }
 */
export function extractRecipeSource(html, url = null) {
  const root = parseHtml(html)
  const structuredData = jsonLdRecipe(root) || microdataRecipe(root)
  const usable = structuredData && (structuredData.ingredients.length > 0 || structuredData.steps.length > 0)
  const text = readableText(root, { maxChars: MAX_TEXT_CHARS })
  const htmlEl = findFirst(root, (el) => el.name === 'html')
  const lang = htmlEl && htmlEl.attrs.lang ? htmlEl.attrs.lang : null
  const base = {
    url: url || null,
    title: (structuredData && structuredData.title) || pageTitle(root) || null,
    yield: null,
    servings: null,
    ingredients: [],
    steps: [],
    times: {},
    text,
    structured: false,
  }
  if (lang) base.lang = lang
  if (!usable) {
    const description = metaContent(root, 'description', 'og:description')
    if (description) base.description = description.slice(0, 1000)
    // Readable text may still hold recognisable ingredient / method sections.
    const guess = textSource(text, { url })
    base.ingredients = guess.ingredients
    base.steps = guess.steps
    base.times = guess.times
    base.yield = guess.yield
    base.servings = guess.servings
    return base
  }
  return { ...base, ...structuredData, title: base.title, url: base.url, text, structured: true }
}

const INGREDIENT_HEADINGS = /^(?:#+\s*)?(ingredients?|you(?:'|’)ll need|what you need|ainekset|ainesosat|zutaten|ingrédients|ingredienser|ingrediënten|ingredientes|ingredienti)\b[:\s]*$/i
const STEP_HEADINGS = /^(?:#+\s*)?(instructions?|method|directions?|preparation|steps?|how to make( it)?|valmistus(?:ohje)?|ohjeet?|työvaiheet|zubereitung|préparation|tillagning|gör så här|bereiding|preparación|elaboración|procedimento)\b[:\s]*$/i
const OTHER_HEADINGS = /^(?:#+\s*)?(notes?|tips?|nutrition|equipment|storage|faq|comments?|reviews?|vinkit|huom)\b[:\s]*$/i

/**
 * Source from pasted (or plain-text) recipe text. Finds "Ingredients" / "Instructions" style sections when present,
 * a title from the first line, yield and times from "Serves 4", "Prep time: 15 min" style lines.
 */
export function textSource(text, { url = null, title = null } = {}) {
  const clean = tidyText(String(text || '').replace(/\r\n?/g, '\n'))
  const lines = clean.split('\n')
  const firstLine = lines.find((l) => l.trim()) || ''
  const ingredients = []
  const steps = []
  let mode = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (INGREDIENT_HEADINGS.test(line)) {
      mode = 'ingredients'
      continue
    }
    if (STEP_HEADINGS.test(line)) {
      mode = 'steps'
      continue
    }
    if (OTHER_HEADINGS.test(line)) {
      mode = null
      continue
    }
    if (mode === 'ingredients') {
      if (line.length > 200) {
        mode = null
        continue
      }
      ingredients.push(stripNumbering(line))
    } else if (mode === 'steps') steps.push(stripNumbering(line))
  }
  const times = {}
  const timeRe = [['prep', /(?:prep(?:aration)?|valmisteluaika)\s*(?:time)?\s*[:\-]?\s*([^\n]{1,40})/i], ['cook', /(?:cook(?:ing)?|bake|baking|kypsennysaika|paistoaika)\s*time\s*[:\-]?\s*([^\n]{1,40})/i], ['total', /(?:total|kokonaisaika)\s*(?:time)?\s*[:\-]?\s*([^\n]{1,40})/i]]
  for (const [key, re] of timeRe) {
    const m = re.exec(clean)
    const s = m ? parseDuration(m[1]) : null
    if (s) times[key] = s
  }
  const yieldMatch = /^(?:serves|servings|yield|makes|portions|annoksia|annos)\s*[:\-]?\s*(.{1,60})$/im.exec(clean)
  const y = yieldMatch ? parseYield(collapse(yieldMatch[0])) : { yield: null, servings: null }
  let text30 = clean
  if (text30.length > MAX_TEXT_CHARS) text30 = text30.slice(0, MAX_TEXT_CHARS) + '\n…'
  return {
    url: url || null,
    title: title || (firstLine.length <= 120 ? collapse(firstLine.replace(/^#+\s*/, '')) : null),
    ...y,
    ingredients: ingredients.filter(Boolean),
    steps: steps.filter(Boolean),
    times,
    text: text30,
    structured: false,
  }
}
