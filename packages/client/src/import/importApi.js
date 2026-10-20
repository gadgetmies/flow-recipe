// REST helpers for the recipe import (server API.md: /api/llm, /api/import, /api/recipes/check|convert, POST
// /api/recipes). In mock mode they resolve to the simulated job in ./mockImport.js, so no server is needed.
// The user's own LLM configuration lives in this browser only (localStorage `flow-recipe-llm`) and is sent nowhere but
// our own server's import endpoint.

import { SERVER_URL } from '../config'
import * as mockApi from './mockImport'

export const LLM_STORAGE_KEY = 'flow-recipe-llm'
export const TOKEN_STORAGE_KEY = 'flow-recipe-upload-token'

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

/** `{ server: { provider, model, baseUrl, hasKey } | null, providers: [...] }` */
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

/** → `{ id, title, check }`; ApiError 409 (id taken), 422 (`data.check` has errors), 401 (token needed). */
export function saveRecipe({ xml, id, overwrite = false }, { mock = false, token } = {}) {
  if (mock) return mockApi.saveRecipe({ xml, id, overwrite })
  return request('/api/recipes', { method: 'POST', body: { xml, id, overwrite }, token })
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

// ---------- XML helpers for the editable title / id ----------

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Replace the recipe's first `<title>` (or add one after `<recipe ...>`). */
export function setRecipeTitle(xml, title) {
  if (!title) return xml
  if (/<title>[\s\S]*?<\/title>/.test(xml)) return xml.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeXml(title)}</title>`)
  return xml.replace(/(<recipe\b[^>]*>)/, `$1\n    <title>${escapeXml(title)}</title>`)
}

/** Set the `id` attribute of the `<recipe>` element. */
export function setRecipeId(xml, id) {
  if (!id) return xml
  return xml.replace(/<recipe\b[^>]*>/, (tag) => (/\sid="[^"]*"/.test(tag) ? tag.replace(/\sid="[^"]*"/, ` id="${id}"`) : tag.replace(/>$/, ` id="${id}">`)))
}

export const isValidRecipeId = (id) => /^[a-z0-9][a-z0-9_-]{0,79}$/.test(id || '')
