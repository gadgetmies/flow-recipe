// The flow-recipe MCP server: tools for an agent (the agent is the LLM) to turn a recipe from the web into scheduler
// friendly recipe XML. All deterministic work (fetching, unit conversion, validation, dry-run planning) is done by
// @flow-recipe/importer and @flow-recipe/scheduler; saving goes to the flow-recipe server or a local directory.

import fs from 'node:fs/promises'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { apiRequest, serverConfig, ApiError } from './api.js'
import * as deps from './deps.js'
import {
  jsonResult,
  textResult,
  errorResult,
  trimDeep,
  parseAmount,
  formatDuration,
  isValidRecipeId,
  isServerRecipeId,
  sniffRecipeAttributes,
  kebab,
} from './format.js'
import { measurementRules, WORKFLOW } from './text.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

const MAX_XML_CHARS = 1_000_000

const xmlArg = z.string().min(1).max(MAX_XML_CHARS).describe('The complete recipe XML document (<recipe version="2"> …).')
const precisionArg = z
  .boolean()
  .optional()
  .describe('True when the user has a precision scale (0.1 g): small amounts of spices/salt/leavening become grams instead of tsp/tbsp.')

/** Wraps a tool handler: thrown errors become isError results with a hint. */
function safe(handler) {
  return async (args, extra) => {
    try {
      return await handler(args || {}, extra)
    } catch (error) {
      if (error instanceof ApiError) {
        return errorResult(error.message, { hint: error.hint, status: error.status ?? undefined, response: trimDeep(error.body ?? undefined) })
      }
      if (error instanceof deps.DependencyError) return errorResult(error.message, { hint: error.hint })
      return errorResult(error, { hint: 'Unexpected failure in the flow-recipe MCP server; check the arguments and try again.' })
    }
  }
}

/** A compact view of a CheckResult that keeps what an agent needs to decide the next step. */
export function presentCheck(check) {
  const trimmed = trimDeep(check, { maxArray: 60, maxString: 2000 })
  const plan = check && check.plan
  const verdict = []
  if (check) {
    verdict.push(check.ok ? 'No errors.' : `${(check.errors || []).length} error(s) — fix them and check again.`)
    if ((check.warnings || []).length) verdict.push(`${check.warnings.length} warning(s).`)
    if ((check.unitLint || []).length) verdict.push(`${check.unitLint.length} unit lint finding(s).`)
    for (const line of describePlan(plan)) verdict.push(line)
  }
  return { verdict: verdict.join(' '), ...trimmed }
}

function describePlan(plan) {
  if (!plan) return ['No dry-run plan.']
  const lines = []
  if (plan.ok === false || plan.error) lines.push(`Dry-run plan FAILED: ${plan.error || 'see plan.diagnostics'}.`)
  const runs = Array.isArray(plan.runs) ? plan.runs : Array.isArray(plan.participants) ? plan.participants : null
  if (runs) {
    for (const run of runs) {
      const n = run.participants ?? run.cooks ?? run.count
      const t = formatDuration(run.makespanSeconds)
      const hands = formatDuration(run.activeSeconds)
      if (n != null && t) lines.push(`${n} cook(s): ${t} start to serve${hands ? ` (${hands} hands-on)` : ''}.`)
    }
    const cp = formatDuration(plan.criticalPathSeconds)
    if (cp) lines.push(`Critical path (unlimited cooks): ${cp}; compare these with the source's total time.`)
  } else {
    for (const [key, label] of [
      ['makespanSeconds', 'Estimated time'],
      ['makespan1Seconds', '1 cook'],
      ['makespan3Seconds', '3 cooks'],
    ]) {
      const t = formatDuration(plan[key])
      if (t) lines.push(`${label}: ${t}.`)
    }
    for (const [key, value] of Object.entries(plan)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.makespanSeconds === 'number') {
        lines.push(`${key}: ${formatDuration(value.makespanSeconds)}.`)
      }
    }
  }
  if (Array.isArray(plan.chains)) lines.push(`${plan.chains.length} pipeline(s) detected.`)
  return lines
}

async function runCheck(xml, { precisionScale = false, id } = {}) {
  const { checkRecipeXml } = await deps.importer()
  const options = { precisionScale: !!precisionScale }
  if (id) options.id = id
  return await checkRecipeXml(xml, options)
}

async function localRecipeIds(dir) {
  try {
    return (await fs.readdir(dir)).filter(f => f.endsWith('.xml') && f !== 'operations.xml').map(f => f.slice(0, -4))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function listLocalRecipes(dir) {
  const out = []
  for (const id of await localRecipeIds(dir)) {
    let title = null
    try {
      title = sniffRecipeAttributes(await fs.readFile(path.join(dir, `${id}.xml`), 'utf-8')).title || null
    } catch {
      // unreadable file: list it without a title
    }
    out.push({ id, title, source: 'local', path: path.join(dir, `${id}.xml`) })
  }
  return out
}

/**
 * Creates the MCP server.
 * @param {{ env?: object, fetch?: typeof fetch }} options
 */
export function createFlowRecipeServer({ env = process.env, fetch = globalThis.fetch } = {}) {
  const config = serverConfig(env)
  const api = (method, p, options = {}) => apiRequest(config, method, p, { fetch, ...options })

  const server = new McpServer(
    { name: 'flow-recipe', title: 'Flow Recipe', version: pkg.version },
    {
      instructions:
        'Tools for turning recipes (URL or text) into flow-recipe XML for the multi-cook scheduler. You write the XML; ' +
        'the tools fetch sources, convert units, validate, dry-run the scheduler and upload. Start with ' +
        'get_authoring_guide, finish with check_recipe (no errors) and upload_recipe.',
    }
  )

  // ---- guide and catalogue ------------------------------------------------------------------------------------

  server.registerTool(
    'get_authoring_guide',
    {
      title: 'Get the recipe authoring guide',
      description:
        'Returns the recipe XML authoring guide (RECIPE.spec.md), the measurement rules and a summary of the operation ' +
        'catalogue. Read it before drafting recipe XML.',
      inputSchema: {
        precisionScale: precisionArg,
        includeCatalogue: z.boolean().optional().describe('Include the operation catalogue summary (default true).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ precisionScale = false, includeCatalogue = true }) => {
      const { loadGuide, catalogueSummary } = await deps.importer()
      const parts = [await loadGuide(), measurementRules({ precisionScale }), WORKFLOW]
      if (includeCatalogue) parts.push(`## Operation catalogue\n\n${catalogueSummary(await deps.catalogue())}`)
      return textResult(parts.join('\n\n---\n\n'))
    })
  )

  server.registerTool(
    'list_operations',
    {
      title: 'List operations',
      description:
        'Summarises the operation catalogue (name, inputs/outputs, options with units, time model, requires). ' +
        'Optional filter: case-insensitive substring matched against the operation name, station and requirements.',
      inputSchema: { filter: z.string().optional().describe('e.g. "bake", "knife", "hob"') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ filter }) => {
      const { catalogueSummary } = await deps.importer()
      const all = await deps.catalogue()
      let selected = all
      if (filter && filter.trim()) {
        const needle = filter.trim().toLowerCase()
        selected = {}
        for (const [name, op] of Object.entries(all)) {
          const haystack = [name, op.station, op.title, op.description, JSON.stringify(op.requires ?? '')]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
          if (haystack.includes(needle)) selected[name] = op
        }
        if (Object.keys(selected).length === 0) {
          return errorResult(`No operation matches "${filter}".`, {
            hint: 'Call list_operations without a filter to see every operation.',
            operations: Object.keys(all),
          })
        }
      }
      return textResult(catalogueSummary(selected))
    })
  )

  // ---- sources ------------------------------------------------------------------------------------------------

  server.registerTool(
    'fetch_recipe_source',
    {
      title: 'Fetch a recipe source',
      description:
        'Fetches a recipe web page and extracts the recipe (schema.org JSON-LD when available: title, yield, ' +
        'ingredients, steps, times in seconds) plus the readable page text. Pass `text` instead of `url` for a ' +
        'recipe the user pasted.',
      inputSchema: {
        url: z.url().optional().describe('http(s) URL of the recipe page'),
        text: z.string().max(200000).optional().describe('Pasted recipe text (instead of url)'),
        maxTextChars: z.number().int().min(500).max(30000).optional().describe('Cap for the returned page text (default 12000).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ url, text, maxTextChars = 12000 }) => {
      if (!url && !text) return errorResult('Pass either `url` or `text`.', { hint: 'Ask the user for the recipe URL or to paste the recipe.' })
      const importer = await deps.importer()
      let source
      if (text) source = await importer.textSource(text, url ? { url } : {})
      else {
        if (!/^https?:\/\//i.test(url)) return errorResult('Only http(s) URLs can be fetched.')
        try {
          // The importer's default fetch pins the SSRF check to the connected address; only pass injected fetches.
          source = await importer.fetchRecipeSource(url, fetch === globalThis.fetch ? {} : { fetch })
        } catch (error) {
          return errorResult(`Could not fetch ${url}: ${error.message}`, {
            hint: 'The site may block automated requests. Ask the user to paste the recipe text and call fetch_recipe_source with `text`.',
          })
        }
      }
      const out = trimDeep(source, { maxString: maxTextChars, maxArray: 200 })
      if (!source.structured && (!source.ingredients || source.ingredients.length === 0)) {
        out.note = 'No structured recipe data found; read the ingredients and steps from `text`.'
      }
      return jsonResult(out)
    })
  )

  // ---- units --------------------------------------------------------------------------------------------------

  server.registerTool(
    'convert_amount',
    {
      title: 'Convert one amount to metric',
      description:
        'Converts one ingredient amount to the flow-recipe measurement rules (weights for weighable ingredients via ' +
        'the density table, ml for thin liquids, metric spoons or 0.1 g for small spice amounts, pieces unchanged).',
      inputSchema: {
        amount: z.union([z.number(), z.string()]).describe('e.g. 2, 1.5, "1 1/2", "¾"'),
        unit: z.string().optional().describe('e.g. "cup", "tbsp", "oz", "lb", "fl oz", "stick"; omit for pieces'),
        ingredient: z.string().optional().describe('Ingredient name, e.g. "all-purpose flour"'),
        precisionScale: precisionArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ amount, unit, ingredient, precisionScale = false }) => {
      const number = parseAmount(amount)
      if (number === null) return errorResult(`Cannot read the amount "${amount}".`, { hint: 'Use a number or a fraction such as "1 1/2".' })
      const { toMetricAmount } = await deps.conversions()
      const result = toMetricAmount({ number, unit: unit || null }, { ingredient: ingredient || null, precisionScale: !!precisionScale })
      if (result && result.density) result.density = compactDensity(result.density)
      return jsonResult(result)
    })
  )

  server.registerTool(
    'lookup_density',
    {
      title: 'Look up an ingredient density',
      description:
        'Finds the density (g/ml) used to turn volumes into weights for an ingredient: the best match and close ' +
        'candidates, with grams per cup/tbsp/tsp.',
      inputSchema: {
        ingredient: z.string().min(1).describe('Ingredient name, e.g. "brown sugar", "rolled oats"'),
        limit: z.number().int().min(1).max(30).optional().describe('Maximum number of candidates (default 8)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ ingredient, limit = 8 }) => {
      const { findDensity, DENSITIES } = await deps.conversions()
      const match = findDensity(ingredient)
      const words = ingredient
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter(w => w.length > 2)
        .map(w => w.replace(/(es|s)$/, ''))
      const scored = []
      for (const entry of DENSITIES || []) {
        if (match && entry.id === match.id) continue
        const names = (entry.names || []).join(' ').toLowerCase()
        const score = words.filter(w => names.includes(w)).length
        if (score > 0) scored.push({ entry, score })
      }
      scored.sort((a, b) => b.score - a.score)
      const candidates = scored.slice(0, limit).map(s => compactDensity(s.entry))
      if (!match && candidates.length === 0) {
        return jsonResult({
          match: null,
          candidates: [],
          note: 'No density known. Keep the volume in ml, or estimate a weight and say so in the recipe.',
        })
      }
      return jsonResult({ match: match ? compactDensity(match) : null, candidates })
    })
  )

  server.registerTool(
    'convert_recipe_units',
    {
      title: 'Convert a recipe to metric',
      description:
        'Rewrites every measure amount, temperature and tool size in the recipe XML to the measurement rules ' +
        '(deterministic; idempotent). Returns the new XML, the list of changes and warnings. Continue with the returned XML.',
      inputSchema: { xml: xmlArg, precisionScale: precisionArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ xml, precisionScale = false }) => {
      const [{ metricizeRecipeXml }, { DOMParser, XMLSerializer }, importer] = await Promise.all([deps.conversions(), deps.xmldom(), deps.importer()])
      const problems = importer.checkWellFormed ? importer.checkWellFormed(xml) : []
      if (problems.length) {
        return errorResult('The XML is not well-formed; nothing was converted.', {
          hint: 'Fix these problems first (check_recipe reports them too).',
          errors: problems.map(p => `line ${p.line}, column ${p.column}: ${p.message}`),
        })
      }
      const result = metricizeRecipeXml(xml, { DOMParser: importer.QuietDOMParser || DOMParser, XMLSerializer, precisionScale: !!precisionScale })
      return jsonResult({
        changes: trimDeep(result.changes, { maxArray: 150 }),
        warnings: result.warnings,
        xml: result.xml,
      })
    })
  )

  // ---- validation ---------------------------------------------------------------------------------------------

  server.registerTool(
    'check_recipe',
    {
      title: 'Check a recipe',
      description:
        'Validates recipe XML: well-formedness, references and operation options against the catalogue, unit lint, ' +
        'and a scheduler dry run with 1 and 3 cooks (estimated time, pipelines, diagnostics). `ok` is true when ' +
        'there are no errors. Fix errors and re-check until ok.',
      inputSchema: { xml: xmlArg, precisionScale: precisionArg, id: z.string().optional().describe('Recipe id to check as (optional)') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ xml, precisionScale = false, id }) => {
      const check = await runCheck(xml, { precisionScale, id })
      return jsonResult(presentCheck(check))
    })
  )

  // ---- server recipes -----------------------------------------------------------------------------------------

  server.registerTool(
    'list_recipes',
    {
      title: 'List recipes',
      description: `Lists the recipes on the flow-recipe server (${config.base})${
        config.recipesDir ? ` and in the local directory ${config.recipesDir}` : ''
      }: built-in and imported, with ids and titles.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async () => {
      if (!config.recipesDir) return jsonResult(await api('GET', '/api/recipes'))
      const local = await listLocalRecipes(config.recipesDir)
      try {
        const remote = await api('GET', '/api/recipes', { timeoutMs: 5000 })
        return jsonResult({ server: remote, local })
      } catch (error) {
        return jsonResult({ server: null, serverError: error.message, local })
      }
    })
  )

  server.registerTool(
    'get_recipe',
    {
      title: 'Get a recipe',
      description: 'Returns the XML of a recipe by id (from FLOW_RECIPES_DIR when set and present, else from the server). Useful as a modelling example.',
      inputSchema: { id: z.string().min(1).describe('Recipe id, e.g. "buns"') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ id }) => {
      if (!isServerRecipeId(id)) return errorResult(`Invalid recipe id "${id}".`, { hint: 'Ids are letters, digits, - and _; use list_recipes.' })
      if (config.recipesDir) {
        try {
          return textResult(await fs.readFile(path.join(config.recipesDir, `${id}.xml`), 'utf-8'))
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
      const xml = await api('GET', `/api/recipes/${encodeURIComponent(id)}`)
      return textResult(typeof xml === 'string' ? xml : JSON.stringify(xml, null, 2))
    })
  )

  server.registerTool(
    'upload_recipe',
    {
      title: 'Upload a recipe',
      description:
        'Checks the recipe locally (refuses when there are errors), then saves it: POST /api/recipes on the ' +
        'flow-recipe server, or writes <FLOW_RECIPES_DIR>/<id>.xml when FLOW_RECIPES_DIR is set. Run check_recipe ' +
        'and show the user a summary first.',
      inputSchema: {
        xml: xmlArg,
        id: z.string().optional().describe('Recipe id (lowercase kebab-case). Default: the recipe’s id attribute or derived from its title.'),
        overwrite: z.boolean().optional().describe('Replace an existing imported recipe with the same id.'),
        precisionScale: precisionArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ xml, id, overwrite = false, precisionScale = false }) => {
      if (id && !isValidRecipeId(id)) {
        return errorResult(`Invalid recipe id "${id}".`, { hint: 'Use lowercase letters, digits and hyphens, e.g. "chocolate-chip-cookies".' })
      }
      const attrs = sniffRecipeAttributes(xml)
      const check = await runCheck(xml, { precisionScale, id: id || (isValidRecipeId(attrs.id) ? attrs.id : undefined) })
      if (!check.ok) {
        return errorResult('Not uploaded: the recipe has errors.', {
          hint: 'Fix the errors below, run check_recipe until ok is true, then upload again.',
          errors: check.errors,
          warnings: check.warnings,
          plan: check.plan && (check.plan.error || check.plan.diagnostics) ? { error: check.plan.error, diagnostics: check.plan.diagnostics } : undefined,
        })
      }
      const title = check.title || attrs.title || null

      if (config.recipesDir) {
        const dir = path.resolve(config.recipesDir)
        await fs.mkdir(dir, { recursive: true })
        const existing = await localRecipeIds(dir)
        let recipeId = id || (isValidRecipeId(attrs.id) ? attrs.id : null) || (isValidRecipeId(check.id) ? check.id : null)
        if (!recipeId) {
          const { suggestRecipeId } = await deps.importer()
          recipeId = suggestRecipeId ? suggestRecipeId(title || 'recipe', existing) : kebab(title) || 'recipe'
        }
        if (!isValidRecipeId(recipeId)) return errorResult(`Cannot derive a valid id ("${recipeId}").`, { hint: 'Pass `id`.' })
        const file = path.join(dir, `${recipeId}.xml`)
        if (existing.includes(recipeId) && !overwrite) {
          return errorResult(`${file} already exists.`, { hint: 'Pass overwrite: true to replace it, or choose another id.' })
        }
        // The saved document's root id always matches its file name / id.
        const { setRootAttributes } = await deps.importer()
        const stored = typeof setRootAttributes === 'function' ? setRootAttributes(xml, { id: recipeId }) : xml
        await fs.writeFile(file, stored.endsWith('\n') ? stored : `${stored}\n`, 'utf-8')
        return jsonResult({
          saved: 'local',
          id: recipeId,
          title,
          path: file,
          warnings: check.warnings,
          verdict: presentCheck(check).verdict,
        })
      }

      const body = { xml }
      const explicitId = id || (isValidRecipeId(attrs.id) ? attrs.id : null)
      if (explicitId) body.id = explicitId
      if (overwrite) body.overwrite = true
      const response = await api('POST', '/api/recipes', { body, auth: true })
      const savedId = response.id || explicitId
      return jsonResult({
        saved: 'server',
        id: savedId,
        title: response.title || title,
        server: config.base,
        recipeUrl: `${config.base}/api/recipes/${encodeURIComponent(savedId)}`,
        startSession: `Open the flow-recipe app and pick "${response.title || title}", or open /?recipe=${savedId}`,
        warnings: check.warnings,
        verdict: presentCheck(response.check || check).verdict,
      })
    })
  )

  server.registerTool(
    'import_recipe_with_server_llm',
    {
      title: 'Import with the server’s LLM',
      description:
        'Asks the flow-recipe server to import a recipe with ITS configured LLM (POST /api/import) and waits for the ' +
        'result. Only for servers with an LLM configured; normally you author the XML yourself. Does not save: ' +
        'review the result, then call upload_recipe.',
      inputSchema: {
        url: z.url().optional(),
        text: z.string().max(200000).optional(),
        precisionScale: precisionArg,
        servings: z.number().int().min(1).max(100).optional(),
        notes: z.string().max(2000).optional().describe('Extra instructions for the LLM'),
        timeoutSeconds: z.number().int().min(5).max(900).optional().describe('How long to wait (default 300)'),
      },
      // Starts a (possibly paid) LLM job on the server: not read-only.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ url, text, precisionScale = false, servings, notes, timeoutSeconds = 300 }, extra) => {
      if (!url && !text) return errorResult('Pass either `url` or `text`.')
      const body = { precisionScale: !!precisionScale }
      if (url) body.url = url
      if (text) body.text = text
      if (servings) body.servings = servings
      if (notes) body.notes = notes
      const { jobId } = await api('POST', '/api/import', { body, auth: true })
      const deadline = Date.now() + timeoutSeconds * 1000
      let job = null
      while (Date.now() < deadline) {
        if (extra?.signal?.aborted) return errorResult('Cancelled.')
        job = await api('GET', `/api/import/${encodeURIComponent(jobId)}`)
        if (job.status === 'done' || job.status === 'error') break
        await new Promise(resolve => setTimeout(resolve, Number(env.FLOW_IMPORT_POLL_MS) || 1000))
      }
      if (!job || (job.status !== 'done' && job.status !== 'error')) {
        return errorResult(`The import job ${jobId} did not finish within ${timeoutSeconds} s (last stage: ${job?.stage || 'unknown'}).`, {
          hint: 'Call again with a larger timeoutSeconds, or author the recipe yourself.',
        })
      }
      if (job.status === 'error') return errorResult(`Server import failed: ${job.error || 'unknown error'}`, { stage: job.stage, attempts: job.attempts })
      const result = job.result || {}
      return jsonResult({
        id: result.id,
        attempts: result.attempts ?? job.attempts,
        llm: result.llm,
        source: result.source,
        conversions: trimDeep(result.conversions, { maxArray: 100 }),
        check: presentCheck(result.check),
        xml: result.xml,
        next: 'Review the XML and the check, fix it if needed (check_recipe), show the user a summary, then upload_recipe.',
      })
    })
  )

  // ---- prompt and resource ------------------------------------------------------------------------------------

  server.registerPrompt(
    'create_recipe_from_url',
    {
      title: 'Create a flow-recipe recipe from a URL',
      description: 'The step-by-step workflow for importing a recipe with these tools.',
      argsSchema: {
        url: z.string().optional().describe('Recipe URL (or leave empty and paste the text)'),
        precisionScale: z.string().optional().describe('"yes" if you have a 0.1 g precision scale'),
      },
    },
    ({ url, precisionScale }) => {
      const scale = /^(y|yes|true|1)$/i.test(String(precisionScale || '').trim())
      const intro = url
        ? `Import this recipe into flow-recipe: ${url}\n${precisionScale ? `Precision scale: ${scale ? 'yes' : 'no'}.` : 'Ask me once whether I have a precision scale.'}`
        : 'Help me import a recipe into flow-recipe. Ask me for the URL (or the recipe text) and whether I have a precision scale.'
      return { messages: [{ role: 'user', content: { type: 'text', text: `${intro}\n\n${WORKFLOW}` } }] }
    }
  )

  server.registerResource(
    'authoring-guide',
    'flow-recipe://authoring-guide',
    { title: 'Recipe authoring guide', description: 'RECIPE.spec.md: the flow-recipe XML authoring guide', mimeType: 'text/markdown' },
    async uri => {
      const { loadGuide } = await deps.importer()
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await loadGuide() }] }
    }
  )

  return server
}

function compactDensity(entry) {
  if (!entry || typeof entry !== 'object') return entry
  const g = entry.gPerMl
  const round = n => Math.round(n * 10) / 10
  return {
    id: entry.id,
    names: (entry.names || []).slice(0, 8),
    kind: entry.kind,
    gPerMl: g,
    // US cup (236.6 ml), the same cup the converter uses.
    ...(typeof g === 'number' ? { gramsPerCup: round(g * 236.5882365), gramsPerTbsp: round(g * 15), gramsPerTsp: round(g * 5) } : {}),
    ...(entry.pieceGrams ? { pieceGrams: entry.pieceGrams } : {}),
    ...(entry.source ? { source: entry.source } : {}),
  }
}
