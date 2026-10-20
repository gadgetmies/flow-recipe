// Simulated import jobs for `?mock=1`: the job walks through the stages on a timer (one repair round included), so
// the progress screen behaves like the real one. A URL containing "blocked" fails while fetching; `&nollm=1` on the
// page URL pretends the server has no LLM configured.

import { makeMockCheck, makeMockResult, MOCK_SOURCE_URL, RECIPES_FIXTURE_IDS } from './mockImport.fixture'

/** Polling interval and mock stage length; tests make them short. */
export const IMPORT_TIMING = { pollMs: 1000, mockStageMs: 1100 }

const STAGES = [
  ['fetching', 'Found schema.org recipe data: 9 ingredients, 8 steps'],
  ['generating', 'Attempt 1'],
  ['converting', '7 amounts converted (cups → g, °F → °C)'],
  ['checking', 'Planning with 1 and 3 cooks'],
  ['repairing', 'Fixing 1 problem: output "dough" is never used'],
  ['converting', 'Nothing left to convert'],
  ['checking', 'Planning with 1 and 3 cooks'],
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
  const step = Math.floor((Date.now() - job.startedAt) / IMPORT_TIMING.mockStageMs)
  const blocked = /blocked/i.test(job.body.url || '')
  if (blocked && step >= 1) {
    return delay({ id: jobId, status: 'error', stage: 'fetching', detail: null, attempts: 0, error: 'Fetching the page failed: 403 Forbidden (the site blocks automated requests)' })
  }
  if (step >= STAGES.length) {
    const result = makeMockResult({ precisionScale: !!job.body.precisionScale, url: job.body.url || MOCK_SOURCE_URL })
    if (job.body.text) result.source = { url: null, title: 'Pasted text', structured: false }
    return delay({ id: jobId, status: 'done', stage: 'done', detail: null, attempts: 2, result })
  }
  const [stage, detail] = STAGES[step]
  return delay({ id: jobId, status: 'running', stage, detail, attempts: step >= 4 ? 2 : 1 })
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

export function saveRecipe({ xml, id }) {
  const finalId = id || idOf(xml)
  if (RECIPES_FIXTURE_IDS.includes(finalId)) {
    return Promise.reject(new MockError(`A built-in recipe already uses the id "${finalId}"`, 409))
  }
  return delay({ id: finalId, title: titleOf(xml), check: clone(makeMockCheck({ id: finalId, title: titleOf(xml) || undefined })) })
}
