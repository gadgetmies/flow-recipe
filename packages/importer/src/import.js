// importRecipe: source → LLM → recipe XML → unit conversion → check → repair loop.

import { XMLSerializer } from '@xmldom/xmldom'
import { fetchRecipeSource, textSource } from './source.js'
import { createLlmClient, describeLlmConfig, DEFAULT_MAX_TOKENS } from './llm.js'
import { buildMessages, buildRepairMessage, catalogueSummary, loadGuide, loadOperationsXml } from './guide.js'
import { catalogueFor, checkRecipeXml, conversions, QuietDOMParser, repairWorthyWarnings } from './check.js'
import { checkWellFormed } from './wellformed.js'
import { decodeEntities } from './html.js'

export class ImportError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ImportError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * Kebab-case recipe id from a title, unique among `existingIds` (appends -2, -3, …). Diacritics are folded
 * (ä → a), the id is at most 60 characters (cut at a word boundary) and never empty ('recipe').
 */
export function suggestRecipeId(title, existingIds = []) {
  let base = String(title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[øØ]/g, 'o')
    .replace(/[œŒ]/g, 'oe')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (base.length > 60) base = base.slice(0, 60).replace(/-[^-]*$/, '') || base.slice(0, 60)
  if (!base) base = 'recipe'
  if (/^[0-9]/.test(base)) base = `recipe-${base}`
  const taken = new Set((existingIds || []).map((x) => String(x)))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * The XML document inside an LLM answer: a ```xml fenced block containing <recipe>, else the text from the first
 * `<?xml` / `<recipe` to the last `</recipe>` (or to the end when the closing tag is missing). null when none.
 */
export function extractXml(text) {
  const s = String(text || '')
  const fences = [...s.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => /<recipe\b/.test(b))
  const body = fences.length ? fences.sort((a, b) => b.length - a.length)[0] : s
  let start = body.search(/<\?xml\b/)
  const recipeAt = body.search(/<recipe\b/)
  if (recipeAt < 0) return null
  if (start < 0 || start > recipeAt) start = recipeAt
  const end = body.lastIndexOf('</recipe>')
  const xml = end > recipeAt ? body.slice(start, end + '</recipe>'.length) : body.slice(start).replace(/```\s*$/, '')
  return xml.trim()
}

function escapeAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

/** Set attributes on the root <recipe> start tag without reformatting the document. */
export function setRootAttributes(xml, attrs) {
  const m = /<recipe\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/.exec(xml)
  if (!m) return xml
  let inner = m[1]
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue
    const re = new RegExp(`(\\s)${name}\\s*=\\s*("[^"]*"|'[^']*')`)
    if (re.test(inner)) inner = inner.replace(re, `$1${name}="${escapeAttr(value)}"`)
    else inner = `${inner.replace(/\s+$/, '')} ${name}="${escapeAttr(value)}"`
  }
  const tag = `<recipe${inner}${m[2]}>`
  return xml.slice(0, m.index) + tag + xml.slice(m.index + m[0].length)
}

function titleOf(xml) {
  const m = /<title>([\s\S]*?)<\/title>/.exec(xml)
  return m ? decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, '')).replace(/\s+/g, ' ').trim() : null
}

function score(check, xml) {
  if (!check) return Infinity
  return (xml ? 0 : 100000) + check.errors.length * 100 + (check.plan && !check.plan.ok ? 10 : 0) + (check.plan ? 0 : 5) + repairWorthyWarnings(check).length
}

function needsRepair(check) {
  return !check.ok || (check.plan !== null && check.plan !== undefined && !check.plan.ok) || repairWorthyWarnings(check).length > 0
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new ImportError('aborted', 'Import was cancelled')
}

/**
 * Import a recipe from a URL, pasted text or a ready Source with an LLM.
 * Stages reported through onProgress(stage, detail): fetching → generating → converting → checking →
 * (repairing → converting → checking)* → done.
 * @returns {Promise<object>} ImportResult = { id, xml, check, conversions, source: { url, title, structured }, attempts, llm, history }
 */
export async function importRecipe({
  url,
  text,
  source,
  llm,
  precisionScale = false,
  servings = null,
  notes = null,
  maxRepairs = 2,
  onProgress = () => {},
  signal,
  existingIds = [],
  id: wantedId = null,
  maxTokens = DEFAULT_MAX_TOKENS,
  fetch,
  guide,
  operationsXml,
} = {}) {
  const progress = (stage, detail = {}) => {
    try {
      onProgress(stage, detail)
    } catch {
      // a broken progress callback must not break the import
    }
  }
  if (!llm) throw new ImportError('config', 'No LLM configured')
  const client = createLlmClient(llm)

  // 1. Source
  throwIfAborted(signal)
  let src = source
  if (!src) {
    if (url) {
      progress('fetching', { url })
      src = await fetchRecipeSource(url, { signal, ...(fetch ? { fetch } : {}) })
    } else if (text && String(text).trim()) {
      progress('fetching', { text: true })
      src = textSource(String(text))
    } else throw new ImportError('input', 'Give a URL or the recipe text')
  }
  if (!src.structured && !String(src.text || '').trim() && !(src.ingredients || []).length) {
    throw new ImportError('empty-source', 'No recipe text was found on the page')
  }

  // 2. Prompt
  const ops = operationsXml || loadOperationsXml()
  const catalogue = catalogueFor(ops)
  const { system, messages } = buildMessages({
    source: src,
    guide: guide !== undefined ? guide : loadGuide(),
    catalogueText: catalogueSummary(catalogue),
    precisionScale,
    servings,
    notes,
  })
  const conversation = [...messages]
  const conv = conversions()

  let best = null
  let repairFailure = null
  const history = []
  let attempts = 0
  for (;;) {
    throwIfAborted(signal)
    progress(attempts === 0 ? 'generating' : 'repairing', { attempt: attempts + 1 })
    let raw
    try {
      raw = await client.complete({ system, messages: conversation, maxTokens, signal })
    } catch (e) {
      // A failed repair round (rate limit, overload, timeout, refusal) must not discard a usable earlier attempt.
      if (!best || (signal && signal.aborted) || (e && e.code === 'aborted')) throw e
      repairFailure = `Repair round ${attempts} failed: ${e && e.message ? e.message : String(e)}`
      break
    }
    attempts++
    conversation.push({ role: 'assistant', content: raw })
    throwIfAborted(signal)

    const extraErrors = []
    if (client.lastStopReason === 'max_tokens') {
      extraErrors.push('Your answer was cut off at the output limit. Write a more compact document: shorter instruction texts, fewer comments, no redundant properties.')
    }
    let xml = extractXml(raw)
    let changes = []
    const convWarnings = []
    let check
    if (!xml) {
      extraErrors.push('Your answer contained no <recipe> XML document.')
      check = { ok: false, id: null, title: null, errors: [...extraErrors], warnings: [], unitLint: [], summary: null, plan: null }
      xml = ''
    } else {
      const title = titleOf(xml) || src.title
      const id = wantedId || suggestRecipeId(title, existingIds)
      xml = setRootAttributes(xml, { version: '2', id, ref: src.url || null })

      progress('converting', { attempt: attempts })
      if (conv && checkWellFormed(xml).length === 0) {
        try {
          const res = conv.metricizeRecipeXml(xml, { DOMParser: QuietDOMParser, XMLSerializer, precisionScale })
          if (res && typeof res.xml === 'string') xml = res.xml
          changes = (res && res.changes) || []
          convWarnings.push(...((res && res.warnings) || []))
        } catch (e) {
          convWarnings.push(`Unit conversion failed: ${e.message}`)
        }
      }

      throwIfAborted(signal)
      progress('checking', { attempt: attempts })
      check = checkRecipeXml(xml, { precisionScale, id, operationsXml: ops })
      check.warnings.push(...convWarnings)
      if (extraErrors.length) {
        check.errors.unshift(...extraErrors)
        check.ok = false
      }
    }
    history.push({ attempt: attempts, errors: check.errors.length, warnings: check.warnings.length, planOk: check.plan ? check.plan.ok : null })
    const candidate = { xml, check, changes }
    if (!best || score(check, xml) <= score(best.check, best.xml)) best = candidate

    if (!needsRepair(check) || attempts > maxRepairs) break
    conversation.push({ role: 'user', content: buildRepairMessage(check, { attempt: attempts }) })
  }

  if (repairFailure) best.check.warnings.push(repairFailure)
  progress('done', { attempts, ok: best.check.ok })
  return {
    id: best.check.id || wantedId || suggestRecipeId(src.title, existingIds),
    xml: best.xml,
    check: best.check,
    conversions: best.changes,
    source: { url: src.url || null, title: src.title || null, structured: !!src.structured },
    attempts,
    history,
    llm: describeLlmConfig(client),
  }
}
