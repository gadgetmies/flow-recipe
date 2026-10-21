// Simulated import jobs for `?mock=1`: the job walks through the stages on a timer (one repair round included), so
// the progress screen behaves like the real one. A URL containing "blocked" fails while fetching; `&nollm=1` on the
// page URL pretends the server has no LLM configured.

import { RECIPES_FIXTURE } from '../mocks/session.fixture'
import { makeMockCheck, makeMockResult, MOCK_IMPORTED_RECIPES, MOCK_SOURCE_URL, RECIPES_FIXTURE_IDS } from './mockImport.fixture'

/** Polling interval and mock stage length; tests make them short. */
export const IMPORT_TIMING = { pollMs: 1000, mockStageMs: 1100 }

// The same `detail` shapes as the real server (importJobs.js + importer/src/import.js): the URL string while fetching,
// `{ attempt }` objects while writing, converting and checking, `{ attempts, ok }` at the end. Pasted text skips fetching.
const STAGES = [
  ['queued', () => null],
  ['fetching', (body) => body.url],
  ['generating', () => ({ attempt: 1 })],
  ['converting', () => ({ attempt: 1 })],
  ['checking', () => ({ attempt: 1 })],
  ['repairing', () => ({ attempt: 2 })],
  ['converting', () => ({ attempt: 2 })],
  ['checking', () => ({ attempt: 2 })],
  ['done', () => ({ attempts: 2, ok: true })],
]

const jobs = new Map()
let counter = 0

const delay = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 30))
const clone = (x) => JSON.parse(JSON.stringify(x))

class MockError extends Error {
  constructor(message, status, data) {
    super(message)
    this.status = status
    this.data = data || {}
  }
}

export function getLlmInfo() {
  const params = new URLSearchParams(window.location.search)
  const noLlm = params.get('nollm') === '1'
  return delay({
    server: noLlm ? null : { provider: 'anthropic', model: 'claude-sonnet-5-5', baseUrl: null, hasKey: true },
    providers: ['anthropic', 'openai', 'openai-compatible', 'ollama'],
  })
}

export function startImport(body = {}) {
  const params = new URLSearchParams(window.location.search)
  if (!body.llm && params.get('nollm') === '1') return Promise.reject(new MockError('No LLM configured', 400))
  const id = `mock-job-${++counter}`
  jobs.set(id, { id, body, startedAt: Date.now() })
  return delay({ jobId: id })
}

export function getImportJob(jobId) {
  const job = jobs.get(jobId)
  if (!job) return Promise.reject(new MockError('Import job not found', 404))
  const stages = job.body.url ? STAGES : STAGES.filter(([stage]) => stage !== 'fetching')
  const step = Math.floor((Date.now() - job.startedAt) / IMPORT_TIMING.mockStageMs)
  const blocked = /blocked/i.test(job.body.url || '')
  if (blocked && step >= 2) {
    return delay({
      id: jobId,
      status: 'error',
      stage: 'fetching',
      detail: job.body.url,
      attempts: 0,
      error: 'The page returned HTTP 403 Forbidden (the site may block automated requests; paste the recipe text instead)',
    })
  }
  if (step >= stages.length) {
    const result = makeMockResult({ precisionScale: !!job.body.precisionScale, url: job.body.url || MOCK_SOURCE_URL })
    if (job.body.text) {
      // like the real importer: pasted text has no page, so the XML has no `ref`
      result.source = { url: null, title: null, structured: false, times: {} }
      result.xml = result.xml.replace(/(<recipe\b[^>]*?)\sref="[^"]*"/, '$1')
    }
    return delay({ id: jobId, status: 'done', stage: 'done', detail: null, attempts: 2, result })
  }
  const [stage, detail] = stages[step]
  const attempts = stage === 'queued' || stage === 'fetching' ? 0 : step >= stages.findIndex(([s]) => s === 'repairing') ? 2 : 1
  return delay({ id: jobId, status: 'running', stage, detail: detail(job.body), attempts })
}

export function forgetImportJob(jobId) {
  jobs.delete(jobId)
}

const titleOf = (xml) => (/<title>([\s\S]*?)<\/title>/.exec(xml) || [])[1]?.trim() || null
const idOf = (xml) => (/<recipe\b[^>]*\sid="([^"]*)"/.exec(xml) || [])[1] || null

export function checkRecipe(xml, { precisionScale = false } = {}) {
  const check = makeMockCheck({ precisionScale, id: idOf(xml) || undefined, title: titleOf(xml) || undefined })
  if (!/<recipe\b/.test(xml) || !/<\/recipe>\s*$/.test(xml)) {
    return delay({ ...check, ok: false, errors: ['XML is not well-formed: the <recipe> element is missing or not closed'], plan: null })
  }
  return delay(check)
}

export function convertRecipe(xml) {
  return delay({ xml, changes: [], warnings: [] })
}

// Imported recipes of the simulated server (two "Beef stew" imports show the duplicate-title case).
const imported = new Map(MOCK_IMPORTED_RECIPES.map((r) => [r.id, { ...r }]))

export function listRecipes() {
  return delay([...RECIPES_FIXTURE.map((r) => ({ ...r, source: 'builtin' })), ...[...imported.values()].map(clone)])
}

export function deleteRecipe(id) {
  if (RECIPES_FIXTURE_IDS.includes(id)) return Promise.reject(new MockError('Built-in recipes cannot be deleted', 403))
  if (!imported.delete(id)) return Promise.reject(new MockError('Recipe not found', 404))
  return delay({ id, deleted: true })
}

export function saveRecipe({ xml, id, overwrite = false }) {
  const finalId = id || idOf(xml)
  if (RECIPES_FIXTURE_IDS.includes(finalId)) {
    return Promise.reject(new MockError(`A built-in recipe already uses the id "${finalId}"`, 409))
  }
  if (imported.has(finalId) && !overwrite) return Promise.reject(new MockError(`A recipe with the id "${finalId}" already exists`, 409))
  const ref = (/<recipe\b[^>]*\sref="([^"]*)"/.exec(xml) || [])[1] || null
  imported.set(finalId, { id: finalId, title: titleOf(xml) || finalId, serving: null, source: 'imported', sourceUrl: ref })
  return delay({ id: finalId, title: titleOf(xml), check: clone(makeMockCheck({ id: finalId, title: titleOf(xml) || undefined })) })
}
