// Minimal client for the flow-recipe server REST API (packages/server/API.md), using global fetch.

export const DEFAULT_SERVER = 'http://localhost:3001'

export class ApiError extends Error {
  constructor(message, { status = null, body = null, hint = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    this.hint = hint
  }
}

export function serverConfig(env = process.env) {
  const base = String(env.FLOW_RECIPE_SERVER || DEFAULT_SERVER).replace(/\/+$/, '')
  return { base, token: env.FLOW_UPLOAD_TOKEN || null, recipesDir: env.FLOW_RECIPES_DIR || null }
}

/**
 * Calls the server. Returns the parsed body (JSON, or text for XML). Throws ApiError with an actionable hint.
 * @param {{ base: string, token: string|null }} config
 * `auth` sends FLOW_UPLOAD_TOKEN; `bearer` sends another bearer token (the connector secret for the handoff endpoints).
 */
export async function apiRequest(config, method, path, { body, auth = false, bearer = null, fetch = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const url = `${config.base}${path}`
  const headers = { Accept: 'application/json, application/xml;q=0.9, */*;q=0.1' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (auth && config.token) headers.Authorization = `Bearer ${config.token}`
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const code = error?.cause?.code || error?.code || error?.name
    throw new ApiError(`Could not reach the flow-recipe server at ${config.base} (${code || error.message}).`, {
      hint:
        'Start it with `yarn start` (or `yarn dev`) in the flow-recipe repo, or point FLOW_RECIPE_SERVER at a running ' +
        'server. To save recipes without a server, set FLOW_RECIPES_DIR (e.g. packages/server/src/recipes) in the MCP config.',
    })
  }
  const type = response.headers.get('content-type') || ''
  const text = await response.text()
  let parsed = text
  if (type.includes('json')) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  if (!response.ok) {
    const serverMessage = parsed && typeof parsed === 'object' && parsed.error ? parsed.error : String(text).slice(0, 300)
    throw new ApiError(`${method} ${path} failed with HTTP ${response.status}: ${serverMessage}`, {
      status: response.status,
      body: parsed,
      hint: hintForStatus(response.status, method, path, config),
    })
  }
  return parsed
}

function hintForStatus(status, method, path, config) {
  if (status === 401 || status === 403) {
    return config.token
      ? 'The server rejected FLOW_UPLOAD_TOKEN. Check that it matches the server’s FLOW_UPLOAD_TOKEN.'
      : 'The server requires an upload token. Set FLOW_UPLOAD_TOKEN in the MCP server env to the server’s token.'
  }
  if (status === 404 && method !== 'GET') {
    return `The server at ${config.base} does not support ${method} ${path}; it may be an older version. Update it, or set FLOW_RECIPES_DIR to save files locally.`
  }
  if (status === 404) return 'Not found. Use list_recipes to see the available ids.'
  if (status === 409) return 'The id is taken. Pass overwrite: true to replace your own imported recipe, or choose another id (built-in recipes cannot be overwritten).'
  if (status === 422) return 'The server’s check found errors; fix them (see `check`) and run check_recipe again.'
  if (status === 400 && path.startsWith('/api/import')) return 'The server has no LLM configured. Author the recipe yourself with the other tools instead.'
  return null
}
