// REST helpers for the recipe import (server API.md: /api/llm, /api/import, /api/recipes/check|convert, POST
// /api/recipes). In mock mode they resolve to the simulated job in ./mockImport.js, so no server is needed.
// The user's own LLM configuration lives in this browser only (localStorage `flow-recipe-llm`) and is sent nowhere but
// our own server's import endpoint.

import { SERVER_URL } from '../config'
import * as mockApi from './mockImport'

export const LLM_STORAGE_KEY = 'flow-recipe-llm'
export const TOKEN_STORAGE_KEY = 'flow-recipe-upload-token'
export const LLM_MODE_STORAGE_KEY = 'flow-recipe-llm-mode'
/** The import handed over to Claude that this tab is waiting for (sessionStorage, so a reload resumes waiting). */
export const CLAUDE_REQUEST_KEY = 'flow-recipe-claude-request'

export { IMPORT_TIMING } from './mockImport'

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message)
    this.status = status
    this.data = data || {}
  }
}

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  let response
  try {
    response = await fetch(`${SERVER_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (e) {
    throw new ApiError('The server cannot be reached. Check your connection and try again.', 0)
  }
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch (e) {
    data = { error: text }
  }
  if (!response.ok) throw new ApiError(data?.error || data?.message || `${response.status} ${response.statusText}`, response.status, data)
  return data
}

/** `{ server: { provider, model, baseUrl, hasKey } | null, providers: [...], claude?: { connector: bool } }` */
export function getLlmInfo(mock = false) {
  if (mock) return mockApi.getLlmInfo()
  return request('/api/llm')
}

/** → `{ jobId }` */
export function startImport(body, { mock = false, token } = {}) {
  if (mock) return mockApi.startImport(body)
  return request('/api/import', { method: 'POST', body, token })
}

/** → `{ id, status, stage, detail, attempts, result?, error? }` */
export function getImportJob(jobId, mock = false) {
  if (mock) return mockApi.getImportJob(jobId)
  return request(`/api/import/${encodeURIComponent(jobId)}`)
}

/** Stop polling a job. The server has no cancel endpoint; a mock job is dropped. */
export function forgetImportJob(jobId, mock = false) {
  if (mock) mockApi.forgetImportJob(jobId)
}

/** Hand an import over to Claude (the Flow Recipe connector) → `{ requestId, prompt, claudeUrl }`; ApiError 503 (no connector), 401. */
export function startClaudeImport(body, { mock = false, token } = {}) {
  if (mock) return mockApi.startClaudeImport(body)
  return request('/api/import/claude', { method: 'POST', body, token })
}

/** → `{ id, status: 'pending'|'claimed'|'ready'|'saved'|'cancelled'|'expired', createdAt, updatedAt, url, result? }` */
export function getClaudeImport(requestId, mock = false) {
  if (mock) return mockApi.getClaudeImport(requestId)
  return request(`/api/import/claude/${encodeURIComponent(requestId)}`)
}

/** Cancel a request handed over to Claude (errors are ignored: the request expires on its own). */
export function cancelClaudeImport(requestId, { mock = false, token } = {}) {
  if (mock) return mockApi.cancelClaudeImport(requestId)
  return request(`/api/import/claude/${encodeURIComponent(requestId)}`, { method: 'DELETE', token }).catch(() => null)
}

/** → CheckResult */
export function checkRecipe(xml, { precisionScale = false, mock = false } = {}) {
  if (mock) return mockApi.checkRecipe(xml, { precisionScale })
  return request('/api/recipes/check', { method: 'POST', body: { xml, precisionScale } })
}

/** → `{ xml, changes, warnings }` */
export function convertRecipe(xml, { precisionScale = false, mock = false } = {}) {
  if (mock) return mockApi.convertRecipe(xml, { precisionScale })
  return request('/api/recipes/convert', { method: 'POST', body: { xml, precisionScale } })
}

/**
 * → `{ id, title, check }`; ApiError 409 (id taken), 422 (`data.check` has errors), 401 (token needed).
 * `importRequestId`: the Claude request the draft came from, which the server then marks saved.
 */
export function saveRecipe({ xml, id, overwrite = false, importRequestId }, { mock = false, token } = {}) {
  if (mock) return mockApi.saveRecipe({ xml, id, overwrite, importRequestId })
  const body = { xml, id, overwrite }
  if (importRequestId) body.importRequestId = importRequestId
  return request('/api/recipes', { method: 'POST', body, token })
}

/** All recipes `[{ id, title, serving, source: 'builtin' | 'imported', sourceUrl? }]`. */
export function listRecipes({ mock = false } = {}) {
  if (mock) return mockApi.listRecipes()
  return request('/api/recipes')
}

/** Delete an imported recipe → `{ id, deleted }`; ApiError 403 (built-in), 404, 401 (token needed). */
export function deleteRecipe(id, { mock = false, token } = {}) {
  if (mock) return mockApi.deleteRecipe(id)
  return request(`/api/recipes/${encodeURIComponent(id)}`, { method: 'DELETE', token })
}

// ---------- browser storage ----------

function readJson(key) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

/** The user's own LLM configuration `{ provider, model, apiKey, baseUrl }` remembered on this device, or null. */
export function loadLlmConfig() {
  const c = readJson(LLM_STORAGE_KEY)
  return c && typeof c === 'object' && c.provider ? c : null
}

export function saveLlmConfig(config) {
  try {
    if (config) window.localStorage.setItem(LLM_STORAGE_KEY, JSON.stringify(config))
    else window.localStorage.removeItem(LLM_STORAGE_KEY)
  } catch (e) {
    // storage unavailable (private mode): the configuration lives for this page only
  }
}

/** `'claude'` when the user last chose to import with Claude on this device (a convenience, not a setting). */
export function loadLlmMode() {
  try {
    return window.localStorage.getItem(LLM_MODE_STORAGE_KEY) || null
  } catch (e) {
    return null
  }
}

export function saveLlmMode(mode) {
  try {
    if (mode === 'claude') window.localStorage.setItem(LLM_MODE_STORAGE_KEY, mode)
    else window.localStorage.removeItem(LLM_MODE_STORAGE_KEY)
  } catch (e) {
    // ignore
  }
}

export function loadUploadToken() {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) || ''
  } catch (e) {
    return ''
  }
}

export function saveUploadToken(token) {
  try {
    if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
    else window.localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch (e) {
    // ignore
  }
}

/** The Claude request this tab waits for: `{ requestId, prompt, claudeUrl, url, precisionScale, startedAt }` or null. */
export function loadClaudeRequest() {
  try {
    const raw = window.sessionStorage.getItem(CLAUDE_REQUEST_KEY)
    const r = raw ? JSON.parse(raw) : null
    return r && typeof r === 'object' && r.requestId ? r : null
  } catch (e) {
    return null
  }
}

export function saveClaudeRequest(request) {
  try {
    if (request) window.sessionStorage.setItem(CLAUDE_REQUEST_KEY, JSON.stringify(request))
    else window.sessionStorage.removeItem(CLAUDE_REQUEST_KEY)
  } catch (e) {
    // storage unavailable: a reload starts over
  }
}

/** Copy text to the clipboard; falls back to a hidden textarea where the Clipboard API is missing or refused. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (e) {
    // not allowed (insecure context, no focus): try the old way
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand && document.execCommand('copy')
    document.body.removeChild(ta)
    return !!ok
  } catch (e) {
    return false
  }
}

// ---------- XML helpers for the editable title / id ----------

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const unescapeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
const escapeAttr = (s) => escapeXml(s).replace(/"/g, '&quot;')

// The recipe's own `<title>` is a direct child of `<recipe>`, before `<ingredients>`/`<tasks>` (task titles are attributes).
const TITLE_RE = /<title>([\s\S]*?)<\/title>/
const ROOT_RE = /<recipe\b[^>]*>/

/** The recipe title in the XML (unescaped), '' when there is none. */
export function getRecipeTitle(xml) {
  const m = TITLE_RE.exec(xml || '')
  return m ? unescapeXml(m[1].trim()) : ''
}

/** The `id` attribute of the `<recipe>` element, '' when there is none. */
export function getRecipeId(xml) {
  const tag = (ROOT_RE.exec(xml || '') || [])[0] || ''
  return unescapeXml((/\sid="([^"]*)"/.exec(tag) || [])[1] || '')
}

/** Replace the recipe's first `<title>` (or add one after `<recipe ...>`). An empty title empties the element. */
export function setRecipeTitle(xml, title) {
  const t = title ?? ''
  if (TITLE_RE.test(xml)) return xml.replace(TITLE_RE, () => `<title>${escapeXml(t)}</title>`)
  if (!t) return xml
  return xml.replace(/(<recipe\b[^>]*>)/, (tag) => `${tag}\n    <title>${escapeXml(t)}</title>`)
}

function setRootAttribute(xml, name, value) {
  const re = new RegExp(`\\s${name}="[^"]*"`)
  return xml.replace(ROOT_RE, (tag) => {
    const attr = ` ${name}="${escapeAttr(value)}"`
    if (re.test(tag)) return tag.replace(re, () => attr)
    return tag.replace(/\s*(\/?)>$/, (end, slash) => `${attr}${slash}>`)
  })
}

/** Set the `id` attribute of the `<recipe>` element (an empty id empties it, so the field and the XML agree). */
export function setRecipeId(xml, id) {
  if (!id && !/\sid="/.test((ROOT_RE.exec(xml) || [])[0] || '')) return xml
  return setRootAttribute(xml, 'id', id || '')
}

/** Set the `ref` (source URL) attribute of the `<recipe>` element unless it already has one. */
export function ensureRecipeRef(xml, ref) {
  if (!ref) return xml
  const tag = (ROOT_RE.exec(xml) || [])[0] || ''
  if (/\sref="[^"]+"/.test(tag)) return xml
  return setRootAttribute(xml, 'ref', ref)
}

export const isValidRecipeId = (id) => /^[a-z0-9][a-z0-9_-]{0,79}$/.test(id || '')
