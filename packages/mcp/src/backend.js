// Backends for the MCP tools. The tool definitions (server.js) are shared; what they read and write goes through a
// backend adapter:
//
//   createHttpBackend()  — stdio server: talks to a flow-recipe server over its REST API (api.js), optionally saving
//                          to a local directory (FLOW_RECIPES_DIR).
//   (remote backend)     — built by the flow-recipe server itself (packages/server/src/services/mcpRemote.js) and
//                          calling its services in-process.
//
// Backend interface (all methods async unless noted; optional ones disable their tools when missing):
//   kind: 'http' | 'remote'
//   target: string                                   — where recipes live, for tool descriptions
//   listRecipes() → JSON value
//   getRecipe(id) → XML string
//   uploadRecipe({ xml, id, overwrite, precisionScale, check, attrs }) → JSON value (the tool result)
//   startServerImport?(body) → { jobId }; getServerImportJob?(jobId) → job      — import_recipe_with_server_llm
//   listPendingImports?() → [{ id, url, createdAt, status }]                  — the "Import with Claude" handoff
//   getPendingImport?(id) → { id, status, url, text, precisionScale, servings, notes, source?, sourceError? }
//   submitImport?({ id, xml }) → { id, status, ready, recipeId, check, conversions, conversionWarnings, keptPrevious, attempts }
// Errors thrown with `status` and `hint` become isError tool results.

import fs from 'node:fs/promises'
import path from 'node:path'
import { apiRequest, serverConfig, ApiError } from './api.js'
import * as deps from './deps.js'
import { isValidRecipeId, sniffRecipeAttributes, kebab } from './format.js'

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

const HANDOFF_HINT =
  'Set FLOW_MCP_SECRET in this MCP server’s environment to the flow-recipe server’s connector secret (the same value ' +
  'as the server’s FLOW_MCP_SECRET), or use the Flow Recipe custom connector in Claude instead.'

/**
 * The stdio server's backend: the flow-recipe REST API (FLOW_RECIPE_SERVER, FLOW_UPLOAD_TOKEN) and optionally a local
 * recipes directory (FLOW_RECIPES_DIR). The handoff tools use `Authorization: Bearer <FLOW_MCP_SECRET>`.
 */
export function createHttpBackend({ env = process.env, fetch = globalThis.fetch } = {}) {
  const config = serverConfig(env)
  const api = (method, p, options = {}) => apiRequest(config, method, p, { fetch, ...options })
  const mcpSecret = env.FLOW_MCP_SECRET || null

  async function handoff(method, p, body) {
    if (!mcpSecret) throw Object.assign(new Error('FLOW_MCP_SECRET is not set for this MCP server.'), { hint: HANDOFF_HINT })
    try {
      return await api(method, p, { body, bearer: mcpSecret, timeoutMs: 60000 })
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || (error.status === 404 && p === '/api/import/claude'))) {
        error.hint = HANDOFF_HINT
      } else if (error instanceof ApiError && error.body && typeof error.body === 'object' && error.body.hint) {
        error.hint = error.body.hint
      }
      throw error
    }
  }

  return {
    kind: 'http',
    target: `the flow-recipe server (${config.base})${config.recipesDir ? ` and the local directory ${config.recipesDir}` : ''}`,
    config,

    async listRecipes() {
      if (!config.recipesDir) return await api('GET', '/api/recipes')
      const local = await listLocalRecipes(config.recipesDir)
      try {
        const remote = await api('GET', '/api/recipes', { timeoutMs: 5000 })
        return { server: remote, local }
      } catch (error) {
        return { server: null, serverError: error.message, local }
      }
    },

    async getRecipe(id) {
      if (config.recipesDir) {
        try {
          return await fs.readFile(path.join(config.recipesDir, `${id}.xml`), 'utf-8')
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
      const xml = await api('GET', `/api/recipes/${encodeURIComponent(id)}`)
      return typeof xml === 'string' ? xml : JSON.stringify(xml, null, 2)
    },

    async uploadRecipe({ xml, id, overwrite = false, check, attrs, verdict }) {
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
        if (!isValidRecipeId(recipeId)) {
          throw Object.assign(new Error(`Cannot derive a valid id ("${recipeId}").`), { hint: 'Pass `id`.' })
        }
        const file = path.join(dir, `${recipeId}.xml`)
        if (existing.includes(recipeId) && !overwrite) {
          throw Object.assign(new Error(`${file} already exists.`), { hint: 'Pass overwrite: true to replace it, or choose another id.' })
        }
        // The saved document's root id always matches its file name / id.
        const { setRootAttributes } = await deps.importer()
        const stored = typeof setRootAttributes === 'function' ? setRootAttributes(xml, { id: recipeId }) : xml
        await fs.writeFile(file, stored.endsWith('\n') ? stored : `${stored}\n`, 'utf-8')
        return { saved: 'local', id: recipeId, title, path: file, warnings: check.warnings, verdict: verdict(check) }
      }

      const body = { xml }
      const explicitId = id || (isValidRecipeId(attrs.id) ? attrs.id : null)
      if (explicitId) body.id = explicitId
      if (overwrite) body.overwrite = true
      const response = await api('POST', '/api/recipes', { body, auth: true })
      const savedId = response.id || explicitId
      return {
        saved: 'server',
        id: savedId,
        title: response.title || title,
        server: config.base,
        recipeUrl: `${config.base}/api/recipes/${encodeURIComponent(savedId)}`,
        startSession: `Open the flow-recipe app and pick "${response.title || title}", or open /?recipe=${savedId}`,
        warnings: check.warnings,
        verdict: verdict(response.check || check),
      }
    },

    async startServerImport(body) {
      return await api('POST', '/api/import', { body, auth: true })
    },

    async getServerImportJob(jobId) {
      return await api('GET', `/api/import/${encodeURIComponent(jobId)}`)
    },

    async listPendingImports() {
      return await handoff('GET', '/api/import/claude')
    },

    async getPendingImport(id) {
      return await handoff('POST', `/api/import/claude/${encodeURIComponent(id)}/claim`, {})
    },

    async submitImport({ id, xml }) {
      return await handoff('POST', `/api/import/claude/${encodeURIComponent(id)}/draft`, { xml })
    },
  }
}
