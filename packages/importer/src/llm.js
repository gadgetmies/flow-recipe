// LLM clients over plain fetch: Anthropic Messages API, OpenAI(-compatible) chat completions, Ollama (OpenAI
// compatible) and a mock for tests. Every client exposes complete({ system, messages, maxTokens, temperature,
// signal }) → Promise<string>. The API key never leaves the client object except in the request header.

export const PROVIDERS = ['anthropic', 'openai', 'openai-compatible', 'ollama', 'mock']

const DEFAULTS = {
  anthropic: { model: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com' },
  openai: { model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
  'openai-compatible': { model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
  ollama: { model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' },
  mock: { model: 'mock', baseUrl: null },
}

export const DEFAULT_TIMEOUT_MS = 180000
export const DEFAULT_MAX_TOKENS = 16000

/** Error from an LLM call with `code` (auth, rate-limit, overloaded, bad-request, http, timeout, aborted, network, refusal, empty) and `status`. */
export class LlmError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    Object.assign(this, extra)
  }
}

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '')
}

function normaliseProvider(p) {
  const k = String(p || '').trim().toLowerCase()
  if (k === 'claude') return 'anthropic'
  if (k === 'openai_compatible' || k === 'compatible' || k === 'custom') return 'openai-compatible'
  return k
}

/**
 * Readable message for an HTTP error from a provider. With `withDetail` false (endpoints a user supplied, which
 * may be internal services) the response body is never read into the message: only the status code.
 */
async function httpError(res, provider, withDetail = true) {
  let detail = ''
  if (!withDetail) {
    try {
      if (res.body && typeof res.body.cancel === 'function') await res.body.cancel()
    } catch {
      // ignore
    }
  } else try {
    const body = await res.text()
    try {
      const json = JSON.parse(body)
      detail = (json.error && (json.error.message || json.error.type)) || json.message || json.detail || ''
      if (typeof detail !== 'string') detail = JSON.stringify(detail)
    } catch {
      detail = body.slice(0, 300)
    }
  } catch {
    // ignore
  }
  const name = provider === 'anthropic' ? 'Anthropic' : provider === 'ollama' ? 'Ollama' : 'OpenAI-compatible API'
  const suffix = detail ? `: ${detail}` : ''
  switch (res.status) {
    case 401:
      return new LlmError('auth', `API key rejected by ${name} (HTTP 401)${suffix}`, { status: 401 })
    case 403:
      return new LlmError('auth', `${name} refused access (HTTP 403): the key lacks permission for this model${suffix ? suffix : ''}`, { status: 403 })
    case 404:
      return new LlmError('bad-request', `${name} returned 404: unknown model or wrong base URL${suffix}`, { status: 404 })
    case 400:
    case 413:
    case 422:
      return new LlmError('bad-request', `${name} rejected the request (HTTP ${res.status})${suffix}`, { status: res.status })
    case 429:
      return new LlmError('rate-limit', `${name} rate limit or quota exceeded (HTTP 429)${suffix}`, { status: 429, retryAfter: res.headers.get('retry-after') })
    case 529:
    case 503:
      return new LlmError('overloaded', `${name} is overloaded or unavailable (HTTP ${res.status}), try again shortly${suffix}`, { status: res.status })
    default:
      return new LlmError('http', `${name} request failed (HTTP ${res.status})${suffix}`, { status: res.status })
  }
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

async function postJson({ url, headers, body, timeoutMs, signal, fetchImpl, provider, errorDetail = true }) {
  if (signal && signal.aborted) throw new LlmError('aborted', 'LLM request was cancelled')
  const timeout = AbortSignal.timeout(timeoutMs)
  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: combineSignals([timeout, signal]),
    })
  } catch (e) {
    if (signal && signal.aborted) throw new LlmError('aborted', 'LLM request was cancelled')
    if (timeout.aborted || e.name === 'TimeoutError') throw new LlmError('timeout', `LLM request timed out after ${Math.round(timeoutMs / 1000)} s`)
    if (e && e.code === 'blocked-address') throw new LlmError('blocked-address', `Cannot reach ${new URL(url).host}: ${e.message}`)
    const cause = e.cause && (e.cause.code || e.cause.message)
    const reason = errorDetail ? cause || e.message : (e.cause && e.cause.code) || e.code || 'connection failed'
    throw new LlmError('network', `Cannot reach ${new URL(url).host}: ${String(reason).slice(0, 200)}`)
  }
  if (!res.ok) throw await httpError(res, provider, errorDetail)
  try {
    return await res.json()
  } catch (e) {
    if (signal && signal.aborted) throw new LlmError('aborted', 'LLM request was cancelled')
    if (timeout.aborted) throw new LlmError('timeout', `LLM request timed out after ${Math.round(timeoutMs / 1000)} s`)
    throw new LlmError('http', errorDetail ? `Invalid JSON from the LLM provider: ${e.message}` : 'Invalid JSON from the LLM provider')
  }
}

/**
 * Create an LLM client.
 * @param {object} config { provider, model?, apiKey?, baseUrl?, mockResponse?, timeoutMs?, fetch?, errorDetail? }
 *   errorDetail: false keeps provider response bodies out of error messages (set it for user-supplied base URLs)
 * @returns {{ provider, model, baseUrl, complete: Function, lastStopReason: string|null, usage: object|null }}
 */
export function createLlmClient(config) {
  if (!config || typeof config !== 'object') throw new LlmError('config', 'No LLM configuration given')
  if (typeof config.complete === 'function') return config // already a client
  const provider = normaliseProvider(config.provider)
  if (!PROVIDERS.includes(provider)) throw new LlmError('config', `Unknown LLM provider '${config.provider}' (expected one of ${PROVIDERS.join(', ')})`)
  const defaults = DEFAULTS[provider]
  const model = (config.model && String(config.model).trim()) || defaults.model
  const baseUrl = trimSlash((config.baseUrl && String(config.baseUrl).trim()) || defaults.baseUrl)
  const apiKey = config.apiKey ? String(config.apiKey).trim() : ''
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS
  const fetchImpl = config.fetch || globalThis.fetch
  const errorDetail = config.errorDetail !== false

  const client = { provider, model, baseUrl: provider === 'mock' ? null : baseUrl, hasKey: !!apiKey, lastStopReason: null, usage: null, calls: 0 }

  if (provider === 'mock') {
    let call = 0
    client.complete = async ({ system, messages = [], signal } = {}) => {
      if (signal && signal.aborted) throw new LlmError('aborted', 'LLM request was cancelled')
      const r = config.mockResponse
      let out
      if (typeof r === 'function') out = await r(messages, { system, call: call++ })
      else if (Array.isArray(r)) out = r[Math.min(call++, r.length - 1)]
      else out = r
      client.calls++
      client.lastStopReason = 'end_turn'
      if (out === undefined || out === null) throw new LlmError('empty', 'Mock LLM has no response configured')
      return String(out)
    }
    return client
  }

  if ((provider === 'anthropic' || provider === 'openai') && !apiKey) {
    throw new LlmError('config', `No API key configured for ${provider}`)
  }

  if (provider === 'anthropic') {
    client.complete = async ({ system, messages = [], maxTokens = DEFAULT_MAX_TOKENS, temperature, signal } = {}) => {
      const body = {
        model,
        max_tokens: maxTokens,
        // The stable system prompt (guide + catalogue) is cached so repair rounds re-read it cheaply.
        system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
        messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })),
      }
      // Current Claude models reject non-default sampling parameters; send temperature only when asked explicitly.
      if (temperature !== undefined && temperature !== null && config.sendTemperature) body.temperature = temperature
      const json = await postJson({
        url: `${baseUrl}/v1/messages`,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body,
        timeoutMs,
        signal,
        fetchImpl,
        provider,
        errorDetail,
      })
      client.calls++
      client.lastStopReason = json.stop_reason || null
      client.usage = json.usage || null
      if (json.stop_reason === 'refusal') {
        const d = json.stop_details || {}
        throw new LlmError('refusal', `The model declined the request${d.explanation && errorDetail ? `: ${d.explanation}` : ''}`)
      }
      const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (!text.trim()) throw new LlmError('empty', `The model returned no text (stop reason ${json.stop_reason || 'unknown'})`)
      return text
    }
    return client
  }

  // openai, openai-compatible, ollama
  client.complete = async ({ system, messages = [], maxTokens = DEFAULT_MAX_TOKENS, temperature = 0.2, signal } = {}) => {
    const body = {
      model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }))],
    }
    if (provider === 'openai' && /^(o\d|gpt-5)/i.test(model)) body.max_completion_tokens = maxTokens
    else body.max_tokens = maxTokens
    if (temperature !== undefined && temperature !== null && !/^(o\d|gpt-5)/i.test(model)) body.temperature = temperature
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {}
    const json = await postJson({ url: `${baseUrl}/chat/completions`, headers, body, timeoutMs, signal, fetchImpl, provider, errorDetail })
    client.calls++
    const choice = (json.choices || [])[0] || {}
    const finish = choice.finish_reason || null
    client.lastStopReason = finish === 'length' ? 'max_tokens' : finish
    client.usage = json.usage || null
    let content = choice.message ? choice.message.content : choice.text
    if (Array.isArray(content)) content = content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('')
    if (!content || !String(content).trim()) {
      if (choice.message && choice.message.refusal) throw new LlmError('refusal', errorDetail ? `The model declined the request: ${choice.message.refusal}` : 'The model declined the request')
      throw new LlmError('empty', `The model returned no text (finish reason ${finish || 'unknown'})`)
    }
    return String(content)
  }
  return client
}

/**
 * LLM configuration from environment variables: FLOW_LLM_PROVIDER, FLOW_LLM_MODEL, FLOW_LLM_API_KEY (falls back to
 * ANTHROPIC_API_KEY / OPENAI_API_KEY), FLOW_LLM_BASE_URL. Without FLOW_LLM_PROVIDER the provider is inferred from
 * whichever key is present (Anthropic first). Returns null when nothing is configured.
 */
export function llmConfigFromEnv(env = process.env) {
  const e = env || {}
  let provider = normaliseProvider(e.FLOW_LLM_PROVIDER)
  if (!provider) {
    if (e.FLOW_LLM_API_KEY && e.FLOW_LLM_BASE_URL) provider = 'openai-compatible'
    else if (e.ANTHROPIC_API_KEY) provider = 'anthropic'
    else if (e.OPENAI_API_KEY) provider = 'openai'
    else return null
  }
  if (!PROVIDERS.includes(provider)) return null
  const fallbackKey = provider === 'anthropic' ? e.ANTHROPIC_API_KEY : provider === 'openai' || provider === 'openai-compatible' ? e.OPENAI_API_KEY : undefined
  const config = { provider }
  if (e.FLOW_LLM_MODEL) config.model = e.FLOW_LLM_MODEL
  const apiKey = e.FLOW_LLM_API_KEY || fallbackKey
  if (apiKey) config.apiKey = apiKey
  if (e.FLOW_LLM_BASE_URL) config.baseUrl = e.FLOW_LLM_BASE_URL
  if ((provider === 'anthropic' || provider === 'openai') && !config.apiKey) return null
  return config
}

/** Safe description of a config or client: { provider, model, baseUrl, hasKey }. Never includes the key. */
export function describeLlmConfig(config) {
  if (!config) return null
  const provider = normaliseProvider(config.provider)
  const defaults = DEFAULTS[provider] || { model: null, baseUrl: null }
  const hasKey = typeof config.complete === 'function' ? config.provider !== 'mock' && !!config.hasKey : !!(config.apiKey && String(config.apiKey).trim())
  return {
    provider,
    model: (config.model && String(config.model).trim()) || defaults.model,
    baseUrl: provider === 'mock' ? null : trimSlash(config.baseUrl || defaults.baseUrl),
    hasKey,
  }
}
